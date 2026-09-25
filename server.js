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

function checkWin(roomId) {
  const room = rooms[roomId];
  if (!room || room.isGameOver) return;
  
  const players = Object.values(room.players);
  if (players.length > 1) { 
    const alivePlayers = players.filter(p => p.alive);
    if (alivePlayers.length <= 1) {
      room.isGameOver = true;
      const winnerId = alivePlayers.length === 1 ? alivePlayers[0].id : null;
      io.to(roomId).emit('game_over', { winnerId });
      
      if (room.itemDropInterval) {
        clearInterval(room.itemDropInterval);
        room.itemDropInterval = null;
      }
    }
  }
}

io.on('connection', (socket) => {
  socket.on('join_room', async ({ roomId, hostUrl }) => {
    if (rooms[roomId] && Object.keys(rooms[roomId].players).length >= 4) {
      socket.emit('room_full');
      return; 
    }

    socket.join(roomId);

    if (!rooms[roomId]) {
      rooms[roomId] = { id: roomId, map: createMap(), players: {}, bombs: [], mines: [], isGameOver: false, itemDropInterval: null };
    }

    const room = rooms[roomId];

    let assignedNumber = -1;
    const currentNumbers = Object.values(room.players).map(p => p.playerNumber);
    for (let i = 1; i <= 4; i++) {
      if (!currentNumbers.includes(i)) {
        assignedNumber = i; 
        break;
      }
    }

    if (assignedNumber !== -1) {
      const spawn = SPAWN_POINTS[assignedNumber - 1];
      room.players[socket.id] = {
        id: socket.id,
        playerNumber: assignedNumber,
        x: spawn.x,
        y: spawn.y,
        startX: spawn.x, 
        startY: spawn.y,
        color: spawn.color,
        alive: true,
        lives: 3,        
        bombLimit: 1,
        bombPower: 1,
        bombBuffCharges: 0,
        fireBuffCharges: 0,
        hasElectricGun: 0,
        hasMine: 0,
        hasShield: false, 
        shieldExpiry: 0, // THÊM: Biến quản lý thời gian hết hạn của khiên
        facingDir: 'down'
      };
    }

    const fullJoinUrl = `${hostUrl}/?room=${roomId}`;
    const qrDataUrl = await QRCode.toDataURL(fullJoinUrl);

    io.to(roomId).emit('room_state', {
      players: room.players,
      map: room.map,
      mines: room.mines,
      qrCode: qrDataUrl,
      roomId
    });
  });

  socket.on('restart_game', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    room.map = createMap();
    room.bombs = [];
    room.mines = [];
    room.isGameOver = false; 
    
    if (room.itemDropInterval) {
      clearInterval(room.itemDropInterval);
      room.itemDropInterval = null;
    }
    
    Object.values(room.players).forEach(p => {
      p.x = p.startX;
      p.y = p.startY;
      p.alive = true;
      p.lives = 3;
      p.bombLimit = 1;
      p.bombPower = 1;
      p.bombBuffCharges = 0;
      p.fireBuffCharges = 0;
      p.hasElectricGun = 0;
      p.hasMine = 0;
      p.hasShield = false;
      p.shieldExpiry = 0;
      p.facingDir = 'down';
    });

    io.to(roomId).emit('game_restarted', { map: room.map, players: room.players, mines: room.mines });
  });

  socket.on('move', ({ roomId, dir }) => {
    const room = rooms[roomId];
    if (!room || !room.players[socket.id] || !room.players[socket.id].alive) return;

    const p = room.players[socket.id];
    p.facingDir = dir;
    
    let nextX = p.x;
    let nextY = p.y;

    if (dir === 'up') nextY--;
    if (dir === 'down') nextY++;
    if (dir === 'left') nextX--;
    if (dir === 'right') nextX++;

    if (room.map[nextY] && [0, 3, 4, 5, 6, 7].includes(room.map[nextY][nextX])) {
      const targetCell = room.map[nextY][nextX];
      
      if ([3, 4, 5, 6, 7].includes(targetCell)) {
        if (targetCell === 3) { p.bombLimit = 2; p.bombBuffCharges = 3; }
        if (targetCell === 4) { p.bombPower = 2; p.fireBuffCharges = 3; }
        if (targetCell === 5) { p.hasElectricGun = 3; } 
        if (targetCell === 6) { p.hasMine = 3; } 
        if (targetCell === 7) { 
          p.hasShield = true; 
          p.shieldExpiry = Date.now() + 9999999; // Lượm item thì khiên không bao giờ hết hạn cho đến khi bị bắn
        } 
        
        room.map[nextY][nextX] = 0; 
        io.to(roomId).emit('map_updated', room.map); 
      }

      p.x = nextX;
      p.y = nextY;

      const mineIdx = room.mines.findIndex(m => m.x === p.x && m.y === p.y);
      if (mineIdx !== -1) {
        const mx = p.x; const my = p.y;
        room.mines.splice(mineIdx, 1);
        
        if (p.hasShield) {
          p.hasShield = false; 
        } else {
          p.lives--;
          if (p.lives > 0) { 
            p.x = p.startX; 
            p.y = p.startY; 
            
            // CẤP KHIÊN HỒI SINH 3 GIÂY
            p.hasShield = true;
            p.shieldExpiry = Date.now() + 3000;
            const pid = p.id;
            setTimeout(() => {
              // Chỉ thu hồi khiên nếu người chơi chưa ăn item khiên khác
              if (rooms[roomId] && rooms[roomId].players[pid] && Date.now() >= rooms[roomId].players[pid].shieldExpiry - 100) {
                rooms[roomId].players[pid].hasShield = false;
                io.to(roomId).emit('player_updated', rooms[roomId].players[pid]);
              }
            }, 3000);

          } 
          else { p.alive = false; }
        }

        io.to(roomId).emit('mine_exploded', {
           explosionCells: [{x: mx, y: my}],
           players: room.players,
           mines: room.mines
        });
        checkWin(roomId); 
      } else {
        io.to(roomId).emit('player_updated', p);
      }
    } else {
      io.to(roomId).emit('player_updated', p);
    }
  });

  socket.on('place_mine', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || !room.players[socket.id] || !room.players[socket.id].alive) return;

    const p = room.players[socket.id];
    if (p.hasMine <= 0) return;
    if (room.mines.some(m => m.x === p.x && m.y === p.y)) return;

    p.hasMine--;
    const mine = { x: p.x, y: p.y, id: Date.now(), ownerId: socket.id };
    room.mines.push(mine);

    io.to(roomId).emit('mine_placed', mine);
    io.to(roomId).emit('player_updated', p);
  });

  socket.on('shoot_gun', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || !room.players[socket.id] || !room.players[socket.id].alive) return;

    const p = room.players[socket.id];
    if (p.hasElectricGun <= 0) return;

    p.hasElectricGun--; 
    io.to(roomId).emit('player_updated', p); 

    const laserCells = [];
    let currX = p.x;
    let currY = p.y;
    let dx = 0, dy = 0;
    
    if (p.facingDir === 'up') dy = -1;
    if (p.facingDir === 'down') dy = 1;
    if (p.facingDir === 'left') dx = -1;
    if (p.facingDir === 'right') dx = 1;

    while (true) {
      currX += dx;
      currY += dy;
      if (!room.map[currY] || room.map[currY][currX] === 1 || room.map[currY][currX] === 2) break; 
      laserCells.push({ x: currX, y: currY });
    }

    Object.values(room.players).forEach((target) => {
      if (target.alive && laserCells.some(c => c.x === target.x && c.y === target.y)) {
        if (target.hasShield) {
          target.hasShield = false; 
        } else {
          target.lives--;
          if (target.lives > 0) { 
            target.x = target.startX; 
            target.y = target.startY; 

            // CẤP KHIÊN HỒI SINH 3 GIÂY
            target.hasShield = true;
            target.shieldExpiry = Date.now() + 3000;
            const tid = target.id;
            setTimeout(() => {
              if (rooms[roomId] && rooms[roomId].players[tid] && Date.now() >= rooms[roomId].players[tid].shieldExpiry - 100) {
                rooms[roomId].players[tid].hasShield = false;
                io.to(roomId).emit('player_updated', rooms[roomId].players[tid]);
              }
            }, 3000);

          } 
          else { target.alive = false; }
        }
      }
    });

    io.to(roomId).emit('laser_fired', {
      laserCells,
      direction: p.facingDir,
      players: room.players
    });
    checkWin(roomId); 
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

    if (p.bombBuffCharges > 0) {
      p.bombBuffCharges--;
      if (p.bombBuffCharges <= 0) p.bombLimit = 1; 
    }
    
    if (p.fireBuffCharges > 0) {
      p.fireBuffCharges--;
      if (p.fireBuffCharges <= 0) p.bombPower = 1; 
    }

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
            if (randomDrop < 0.12) room.map[targetY][targetX] = 3;       
            else if (randomDrop < 0.24) room.map[targetY][targetX] = 4;   
            else if (randomDrop < 0.36) room.map[targetY][targetX] = 5;  
            else if (randomDrop < 0.48) room.map[targetY][targetX] = 6;  
            else if (randomDrop < 0.60) room.map[targetY][targetX] = 7;  
            else room.map[targetY][targetX] = 0;
            break; 
          }
        }
      });

      room.mines = room.mines.filter(m => !explosionCells.some(c => c.x === m.x && c.y === m.y));

      Object.values(room.players).forEach((player) => {
        if (player.alive && explosionCells.some(c => c.x === player.x && c.y === player.y)) {
          if (player.hasShield) {
            player.hasShield = false; 
          } else {
            player.lives--;
            if (player.lives > 0) { 
              player.x = player.startX; 
              player.y = player.startY; 

              // CẤP KHIÊN HỒI SINH 3 GIÂY
              player.hasShield = true;
              player.shieldExpiry = Date.now() + 3000;
              const pid = player.id;
              setTimeout(() => {
                if (rooms[roomId] && rooms[roomId].players[pid] && Date.now() >= rooms[roomId].players[pid].shieldExpiry - 100) {
                  rooms[roomId].players[pid].hasShield = false;
                  io.to(roomId).emit('player_updated', rooms[roomId].players[pid]);
                }
              }, 3000);

            } 
            else { player.alive = false; }
          }
        }
      });

      io.to(roomId).emit('bomb_exploded', {
        bombId: bomb.id,
        explosionCells,
        updatedMap: room.map,
        players: room.players,
        mines: room.mines 
      });
      checkWin(roomId); 

      let hasBlocks = false;
      for (let r = 0; r < room.map.length; r++) {
        if (room.map[r].includes(2)) {
          hasBlocks = true;
          break;
        }
      }

      if (!hasBlocks && !room.itemDropInterval && !room.isGameOver) {
        room.itemDropInterval = setInterval(() => {
          if (room.isGameOver) {
            clearInterval(room.itemDropInterval);
            room.itemDropInterval = null;
            return;
          }

          const emptyCells = [];
          for (let r = 0; r < room.map.length; r++) {
            for (let c = 0; c < room.map[r].length; c++) {
              const isPlayerHere = Object.values(room.players).some(p => p.alive && p.x === c && p.y === r);
              const isBombHere = room.bombs.some(b => b.x === c && b.y === r);
              const isMineHere = room.mines.some(m => m.x === c && m.y === r);

              if (room.map[r][c] === 0 && !isPlayerHere && !isBombHere && !isMineHere) {
                emptyCells.push({ r, c });
              }
            }
          }

          if (emptyCells.length > 0) {
            const randCell = emptyCells[Math.floor(Math.random() * emptyCells.length)];
            const items = [3, 4, 5, 5, 5, 6]; 
            const randomItem = items[Math.floor(Math.random() * items.length)];
            
            room.map[randCell.r][randCell.c] = randomItem;
            io.to(roomId).emit('map_updated', room.map);
          }
        }, 12000); 
      }

    }, 2500);
  });

  socket.on('disconnect', () => {
    for (const rId in rooms) {
      if (rooms[rId].players[socket.id]) {
        delete rooms[rId].players[socket.id];
        io.to(rId).emit('player_left', socket.id);
        checkWin(rId); 
        
        if (Object.keys(rooms[rId].players).length === 0) {
          if (rooms[rId].itemDropInterval) {
            clearInterval(rooms[rId].itemDropInterval);
          }
          delete rooms[rId];
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server chạy tại: http://localhost:${PORT}`));