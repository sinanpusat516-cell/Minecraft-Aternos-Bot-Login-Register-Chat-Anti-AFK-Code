const mineflayer = require('mineflayer');
const config = require('./config.json');
const readline = require('readline');

// Terminalden komut okumak için arayüz
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const JUMP_INTERVAL = 5000; // Her 5 saniye
const JUMP_DURATION = 500;

let bot;
let reconnectAttempts = 0;
let reconnectTimer;
let behaviorTimer;
let jumpTimer;
let nextShortRestAt;
let nextLongRestAt;
let restEndsAt = 0;
let restType;

// Tuş modunun açık/kapalı durumu
let tradeTusMode = false;

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function clearBehaviorTimers() {
  clearTimeout(behaviorTimer);
  clearTimeout(jumpTimer);
  behaviorTimer = undefined;
  jumpTimer = undefined;
}

function stopActions(currentBot) {
  clearTimeout(jumpTimer);
  jumpTimer = undefined;

  try {
    currentBot.clearControlStates();
  } catch (err) {
    // Bağlantı kapanmak üzere olabilir.
  }
}

function startJumping(currentBot) {
  function jumpCycle() {
    if (restEndsAt > Date.now() || bot !== currentBot || !currentBot.entity) return;

    currentBot.setControlState('jump', true);
    jumpTimer = setTimeout(() => {
      if (restEndsAt <= Date.now() && bot === currentBot && currentBot.entity) {
        currentBot.setControlState('jump', false);
      }
    }, JUMP_DURATION);

    jumpTimer = setTimeout(jumpCycle, JUMP_INTERVAL);
  }

  jumpCycle();
}

function scheduleBehavior(currentBot, startOnResume = true) {
  clearTimeout(behaviorTimer);
  if (bot !== currentBot || !currentBot.entity) return;

  const now = Date.now();
  if (restEndsAt > now) {
    stopActions(currentBot);
    behaviorTimer = setTimeout(() => scheduleBehavior(currentBot), restEndsAt - now);
    return;
  }

  if (restType) {
    restType = undefined;
    restEndsAt = 0;
    console.log('▶️ Dinlenme bitti; aktiviteye devam ediliyor.');
    if (startOnResume) startJumping(currentBot);
  }

  if (now >= nextLongRestAt) {
    beginRest(currentBot, 'long');
    return;
  }

  if (now >= nextShortRestAt) {
    beginRest(currentBot, 'short');
    return;
  }

  behaviorTimer = setTimeout(
    () => scheduleBehavior(currentBot),
    Math.max(1, Math.min(nextShortRestAt, nextLongRestAt) - now)
  );
}

function beginRest(currentBot, type) {
  const isLong = type === 'long';
  const durationMinutes = isLong ? randomBetween(5, 8) : randomBetween(2, 3);
  restType = type;
  restEndsAt = Date.now() + durationMinutes * MINUTE;
  nextShortRestAt = restEndsAt + randomBetween(30, 60) * MINUTE;
  if (isLong) nextLongRestAt = restEndsAt + 3 * HOUR;

  stopActions(currentBot);
  console.log(`☕ ${isLong ? 'Uzun' : 'Kısa'} molaya girildi, süre: ${durationMinutes} dakika.`);
  scheduleBehavior(currentBot);
}

function createBot() {
  const currentBot = mineflayer.createBot({
    host: config.serverHost,
    port: config.serverPort,
    username: config.botUsername,
    auth: 'offline',
    version: false,
    viewDistance: config.botChunk
  });
  bot = currentBot;

  let readyTimer;
  let stableTimer;
  let ended = false;

  currentBot.once('inject_allowed', () => {
    const sendsClientTickEndPacket = currentBot.supportFeature('sendsClientTickEndPacket');
    console.log(`[protokol] Mineflayer ${currentBot.version} (protokol ${currentBot.protocolVersion}), tick_end ${sendsClientTickEndPacket ? 'etkin' : 'gerekli değil'}.`);

    const writePacket = currentBot._client.write.bind(currentBot._client);
    let supplementedPackets = 0;
    let teleportConfirms = 0;
    currentBot._client.write = (name, packet) => {
      const result = writePacket(name, packet);
      if (sendsClientTickEndPacket && currentBot._client.state === 'play' && ['position', 'position_look', 'look', 'flying'].includes(name)) {
        writePacket('tick_end', {});
        supplementedPackets += 1;
        if (supplementedPackets <= 3) {
          console.log(`[protokol] ${name} paketinden sonra tick_end gönderildi (#${supplementedPackets}).`);
        }
      }
      if (name === 'teleport_confirm' && teleportConfirms < 3) {
        teleportConfirms += 1;
        console.log(`[protokol] teleport_confirm #${teleportConfirms}: ${JSON.stringify(packet)}.`);
      }
      return result;
    };

    let receivedPositions = 0;
    currentBot._client.on('position', (packet) => {
      if (receivedPositions >= 3) return;
      receivedPositions += 1;
      console.log(`[protokol] Sunucu pozisyonu #${receivedPositions}: ${JSON.stringify({ teleportId: packet.teleportId, x: packet.x, y: packet.y, z: packet.z, yaw: packet.yaw, pitch: packet.pitch })}.`);
    });
  });

  // Minecraft chat mesajlarını ve hatalarını konsola yazdırma
  currentBot.on('message', (jsonMsg) => {
    const messageText = jsonMsg.toString();
    console.log(`[Sohbet/Hata]: ${messageText}`);
  });

  function clearSessionTimers() {
    clearTimeout(readyTimer);
    clearTimeout(stableTimer);
    clearTimeout(behaviorTimer);
    clearTimeout(jumpTimer);
  }

  currentBot.on('spawn', () => {
    clearTimeout(readyTimer);
    clearTimeout(stableTimer);
    stopActions(currentBot);
    stableTimer = setTimeout(() => {
      if (!ended && bot === currentBot) reconnectAttempts = 0;
    }, 60000);
    readyTimer = setTimeout(() => {
      if (ended || bot !== currentBot || !currentBot.entity) return;
      console.log(`✅ ${config.botUsername} hazır!`);
    }, 3000);

    // 1.5 saniye aralıklarla sıralı komutlar:
    setTimeout(() => {
      if (bot === currentBot && currentBot.entity) {
        currentBot.chat('/register CodeConfig831 CodeConfig831');
        console.log('✍️ Kayıt komutu gönderildi.');
      }
    }, 1500);

    setTimeout(() => {
      if (bot === currentBot && currentBot.entity) {
        currentBot.chat('/login CodeConfig831');
        console.log('🔑 Giriş komutu gönderildi.');
      }
    }, 3000);

    const now = Date.now();
    if (nextShortRestAt === undefined) nextShortRestAt = now + randomBetween(30, 60) * MINUTE;
    if (nextLongRestAt === undefined) nextLongRestAt = now + 3 * HOUR;
    scheduleBehavior(currentBot, false);
    if (restEndsAt <= now) startJumping(currentBot);
  });

  currentBot.on('error', (err) => {
    console.error('⚠️ Hata:', err);
  });

  currentBot.on('end', () => {
    if (ended) return;
    ended = true;
    clearSessionTimers();
    if (bot === currentBot) bot = undefined;
    console.log('⛔️ Bot bağlantısı kesildi!');
    if (reconnectTimer) return;

    const delay = Math.min(5000 * 2 ** reconnectAttempts, 60000);
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      createBot();
    }, delay);
  });
}

// Visual Studio / Terminal Kontrol Sistemi
rl.on('line', (line) => {
  const input = line.trim();

  // /trade trade tus komutu ile modu açıp kapama
  if (input === '/trade trade tus') {
    tradeTusMode = !tradeTusMode;
    if (tradeTusMode) {
      console.log('🎮 [TRADE TUŞ MODU] Açıldı! Şimdi basılmasını istediğin tuş adını yazabilirsin (Örn: forward, jump).');
    } else {
      console.log('🔒 [TRADE TUŞ MODU] Kapatıldı.');
    }
    return;
  }

  // Eğer trade tuş modu aktifse, yazılan metni doğrudan botun tuş komutu olarak algıla
  if (tradeTusMode) {
    const tus = input;
    if (bot && bot.entity && tus) {
      bot.setControlState(tus, true);
      console.log(`🎮 Bot "${tus}" tuşuna bastı.`);
      setTimeout(() => {
        bot.setControlState(tus, false);
        console.log(`🎮 Bot "${tus}" tuşunu bıraktı.`);
      }, 1000);
    } else {
      console.log('⚠️ Bot henüz oyunda değil veya geçersiz tuş!');
    }
    return;
  }

  if (!bot || !bot.entity) {
    console.log('⚠️ Bot henüz oyunda değil!');
    return;
  }

  // Normal --yaz komutu
  if (input.startsWith('--yaz ')) {
    const mesaj = input.slice(6).trim();
    if (mesaj) {
      bot.chat(mesaj);
      console.log(`💬 Chate yazıldı: "${mesaj}"`);
    }
  }
});

function start() {
  createBot();
}

start();