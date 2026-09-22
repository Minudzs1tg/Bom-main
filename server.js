const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

function createMap() {
  const map = [];
  for (let r = 0; r < 13; r++) {
    const row = [];
    for (let c = 0; c < 15; c++) {
      if (r === 0 || r === 12 || c === 0 || c === 14 || (r % 2 === 0 && c % 2 === 0)) {
        row.push(1);
      } else if ((r <= 2 && c <= 2) || (r >= 10 && c >= 12) || (r <= 2 && c >= 12) || (r >= 10 && c <= 2)) {
        row.push(0);
      } else {
        row.push(Math.random() < 0.65 ? 2 : 0);
      }
    }
    map.push(row);
  }
  return map;
}

const SPAWN_POINTS = [
  { x: 1, y: 1, color: '#e74c3c' },   
  { x: 13, y: 11, color: '#3498db' }, 
  { x: 13, y: 1, color: '#2ecc71' },  
  { x: 1, y: 11, color: '#f1c40f' }   
];

io.on('connection', (socket) => {
  socket.on('join_room', async ({ roomId, hostUrl }) => {
    socket.join(roomId);

    if (!rooms[roomId]) {
      rooms[roomId] = { id: roomId, map: createMap(), players: {}, bombs: [] };
    }

    const room = rooms[roomId];
    const playerIndices = Object.keys(room.players).length;

    if (playerIndices < 4) {
      const spawn = SPAWN_POINTS[playerIndices];
      room.players[socket.id] = {
        id: socket.id,
        x: spawn.x,
        y: spawn.y,
        startX: spawn.x, 
        startY: spawn.y,
        color: spawn.color,
        alive: true,
        lives: 3,        
        bombLimit: 1,
        bombPower: 1,
        bombBuffCharges: 0, // Số lượt buff bom còn lại
        fireBuffCharges: 0  // Số lượt buff lửa còn lại
      };
    }

    const fullJoinUrl = `${hostUrl}/?room=${roomId}`;
    const qrDataUrl = await QRCode.toDataURL(fullJoinUrl);

    io.to(roomId).emit('room_state', {
      players: room.players,
      map: room.map,
      qrCode: qrDataUrl,
      roomId
    });
  });

  socket.on('restart_game', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    room.map = createMap();
    room.bombs = [];
    Object.values(room.players).forEach(p => {
      p.x = p.startX;
      p.y = p.startY;
      p.alive = true;
      p.lives = 3;
      p.bombLimit = 1;
      p.bombPower = 1;
      p.bombBuffCharges = 0; // Reset số lượt buff
      p.fireBuffCharges = 0; // Reset số lượt buff
    });

    io.to(roomId).emit('game_restarted', {
      map: room.map,
      players: room.players
    });
  });

  socket.on('move', ({ roomId, dir }) => {
    const room = rooms[roomId];
    if (!room || !room.players[socket.id] || !room.players[socket.id].alive) return;

    const p = room.players[socket.id];
    let nextX = p.x;
    let nextY = p.y;

    if (dir === 'up') nextY--;
    if (dir === 'down') nextY++;
    if (dir === 'left') nextX--;
    if (dir === 'right') nextX++;

    if (room.map[nextY] && [0, 3, 4].includes(room.map[nextY][nextX])) {
      const targetCell = room.map[nextY][nextX];
      
      if (targetCell === 3 || targetCell === 4) {
        // TÍNH NĂNG MỚI: KHÔNG CỘNG DỒN, RESET VỀ 3 LƯỢT
        if (targetCell === 3) {
          p.bombLimit = 2; // Tối đa chỉ là 2
          p.bombBuffCharges = 3; // Được 3 lượt dùng
        }
        if (targetCell === 4) {
          p.bombPower = 2; // Tối đa chỉ là 2
          p.fireBuffCharges = 3; // Được 3 lượt dùng
        }
        
        room.map[nextY][nextX] = 0; 
        io.to(roomId).emit('map_updated', room.map); 
        io.to(roomId).emit('player_updated', p); 
      }

      p.x = nextX;
      p.y = nextY;
      io.to(roomId).emit('player_moved', { id: socket.id, x: p.x, y: p.y });
    }
  });

  socket.on('place_bomb', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || !room.players[socket.id] || !room.players[socket.id].alive) return;

    const p = room.players[socket.id];
    const activeBombs = room.bombs.filter(b => b.ownerId === socket.id).length;
    if (activeBombs >= p.bombLimit) return;

    const bomb = { x: p.x, y: p.y, id: Date.now(), ownerId: socket.id, power: p.bombPower };
    room.bombs.push(bomb);
    io.to(roomId).emit('bomb_placed', bomb);

    // TÍNH NĂNG MỚI: TRỪ LƯỢT BUFF MỖI KHI ĐẶT BOM
    if (p.bombBuffCharges > 0) {
      p.bombBuffCharges--;
      if (p.bombBuffCharges <= 0) p.bombLimit = 1; // Hết 3 lượt -> Trở về mặc định 1
    }
    
    if (p.fireBuffCharges > 0) {
      p.fireBuffCharges--;
      if (p.fireBuffCharges <= 0) p.bombPower = 1; // Hết 3 lượt -> Trở về mặc định 1
    }

    // Báo cho client cập nhật lại số lượt hiển thị trên thanh HUD
    io.to(roomId).emit('player_updated', p); 

    setTimeout(() => {
      room.bombs = room.bombs.filter(b => b.id !== bomb.id);
      const explosionCells = [{ x: bomb.x, y: bomb.y }];
      const directions = [[0, 1], [0, -1], [1, 0], [-1, 0]];

      directions.forEach(([dx, dy]) => {
        for (let i = 1; i <= bomb.power; i++) {
          const targetX = bomb.x + dx * i;
          const targetY = bomb.y + dy * i;

          if (!room.map[targetY] || room.map[targetY][targetX] === 1) break; 
          explosionCells.push({ x: targetX, y: targetY });

          if (room.map[targetY][targetX] === 2) {
            const randomDrop = Math.random();
            if (randomDrop < 0.2) room.map[targetY][targetX] = 3;
            else if (randomDrop < 0.4) room.map[targetY][targetX] = 4;
            else room.map[targetY][targetX] = 0;
            break; 
          }
        }
      });

      Object.values(room.players).forEach((player) => {
        if (player.alive && explosionCells.some(c => c.x === player.x && c.y === player.y)) {
          player.lives--;
          if (player.lives > 0) {
            player.x = player.startX;
            player.y = player.startY;
          } else {
            player.alive = false;
          }
        }
      });

      io.to(roomId).emit('bomb_exploded', {
        bombId: bomb.id,
        explosionCells,
        updatedMap: room.map,
        players: room.players
      });
    }, 2500);
  });

  socket.on('disconnect', () => {
    for (const rId in rooms) {
      if (rooms[rId].players[socket.id]) {
        delete rooms[rId].players[socket.id];
        io.to(rId).emit('player_left', socket.id);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server chạy tại: http://localhost:${PORT}`));