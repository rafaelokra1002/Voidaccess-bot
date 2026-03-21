console.log('[BOOT] Iniciando bot...');
require('dotenv').config();
console.log('[BOOT] dotenv carregado');
const fs = require('fs');
const path = require('path');
console.log('[BOOT] Carregando Baileys...');
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers, DisconnectReason, extractMessageContent, getContentType, downloadMediaMessage } = require('@whiskeysockets/baileys');
console.log('[BOOT] Baileys carregado');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const { createTest: createOkraTest } = require('./services/okra.service');
const { createTest: createWplayTest } = require('./services/wplay.service');
const { registerMac } = require('./services/pop.service');
const { createUser: createCreditoProUser } = require('./services/creditopro.service');
const validateMac = require('./utils/validateMac');
const { startPanel, readConfig, botState, checkRateLimit, isWithinBusinessHours } = require('./panel');
console.log('[BOOT] Todos os módulos carregados');

function getConfig() {
  return readConfig();
}

// Usar estado compartilhado com o painel
const sessions = botState.sessions;
const testHistory = botState.testHistory;

const LOG_FILE = path.join(__dirname, '..', 'atendimentos.log');

let retryCount = 0;
let sock;

// Follow-up scheduler
const followUpScheduled = new Set();
function scheduleFollowUp(jid) {
  if (followUpScheduled.has(jid)) return;
  const cfg = getConfig();
  if (!cfg.followUp?.enabled) return;
  followUpScheduled.add(jid);
  const delay = (cfg.followUp.delayHours || 24) * 60 * 60 * 1000;
  setTimeout(async () => {
    followUpScheduled.delete(jid);
    try {
      const currentCfg = getConfig();
      if (!currentCfg.followUp?.enabled) return;
      await sock.sendMessage(jid, { text: currentCfg.followUp.message || 'Gostou do teste? Envie oi!' });
    } catch (e) { console.error('Erro follow-up:', e.message); }
  }, delay);
}

// Filtrar log spam do Baileys (Closing session, Connection closed)
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = function (chunk, ...rest) {
  const str = typeof chunk === 'string' ? chunk : chunk.toString();
  if (str.includes('Closing session') || str.includes('SessionEntry') || str.includes('Connection closed')) return true;
  return originalStdoutWrite(chunk, ...rest);
};

function logAtendimento(user, tipo, detalhes) {
  const timestamp = new Date().toLocaleString('pt-BR');
  const line = `[${timestamp}] ${user} | ${tipo} | ${detalhes}\n`;
  fs.appendFileSync(LOG_FILE, line);
  console.log(`📋 LOG: ${line.trim()}`);
}

function resetSession(user) {
  if (sessions[user]?.timeout) clearTimeout(sessions[user].timeout);
  sessions[user] = { step: 0 };
}

function refreshTimeout(user) {
  if (sessions[user]?.timeout) clearTimeout(sessions[user].timeout);
  const cfg = getConfig();
  const timeout = (cfg.sessionTimeout || 10) * 60 * 1000;
  const expiredMsg = cfg.messages?.sessionExpired || '⏰ Sua sessão expirou por inatividade. Envie *oi* para recomeçar!';
  sessions[user].timeout = setTimeout(async () => {
    if (sessions[user] && sessions[user].step !== 0) {
      await sock.sendMessage(user, { text: expiredMsg });
      resetSession(user);
    }
  }, timeout);
}

function detectSystem(brand) {
  const cfg = getConfig();
  const tvBrands = cfg.tvBrands || {};
  const input = brand.toLowerCase();
  for (const [key, system] of Object.entries(tvBrands)) {
    if (input.includes(key)) return system;
  }
  return null;
}

// === Baileys helpers ===

async function sendText(jid, text) {
  await sock.sendMessage(jid, { text });
}

async function sendPresence(jid) {
  try {
    await sock.presenceSubscribe(jid);
    await sock.sendPresenceUpdate('composing', jid);
  } catch (e) { /* ignore presence errors */ }
}

// === Conectar ao WhatsApp ===

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, '..', 'auth_info'));
  const { version } = await fetchLatestBaileysVersion();
  console.log(`📱 Baileys versão: ${version.join('.')}`);

  const logger = pino({ level: 'silent' });

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    browser: Browsers.windows('Chrome'),
    printQRInTerminal: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 0,
    keepAliveIntervalMs: 30000,
    retryRequestDelayMs: 3000,
  });

  // Salvar credenciais
  sock.ev.on('creds.update', saveCreds);

  // Conexão
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    const cfg = getConfig();
    const MAX_RETRIES = cfg.maxRetries || 5;

    if (qr) {
      botState.qrCode = qr;
      botState.status = 'waiting_qr';
      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(qr)}`;
      console.log('\n========================================');
      console.log('📲 ESCANEIE O QR CODE (ou veja no painel)');
      console.log('========================================');
      console.log(qrUrl);
      console.log('========================================\n');
    }

    if (connection === 'open') {
      retryCount = 0;
      botState.status = 'connected';
      botState.qrCode = null;
      botState.startedAt = botState.startedAt || Date.now();
      botState.sock = sock;
      console.log('\n✅ Bot conectado ao WhatsApp!');
      console.log('⚡ VoidAccess Tech Bot - Baileys');
      console.log('📡 Pronto para receber mensagens!\n');
    }

    if (connection === 'close') {
      botState.status = 'disconnected';
      botState.sock = null;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const reason = DisconnectReason[statusCode] || statusCode;
      console.log(`❌ Conexão fechada: ${reason} (${statusCode})`);

      if (statusCode === DisconnectReason.loggedOut) {
        console.log('🔒 Deslogado. Limpando auth_info e reiniciando para gerar novo QR...');
        const authPath = path.join(__dirname, '..', 'auth_info');
        if (fs.existsSync(authPath)) {
          fs.rmSync(authPath, { recursive: true, force: true });
        }
        setTimeout(startBot, 3000);
        return;
      }

      if (retryCount < MAX_RETRIES) {
        retryCount++;
        console.log(`🔄 Reconectando... tentativa ${retryCount}/${MAX_RETRIES}`);
        setTimeout(startBot, 3000);
      } else {
        console.log('💀 Máximo de tentativas atingido. Reiniciando em 30s...');
        retryCount = 0;
        setTimeout(startBot, 30000);
      }
    }
  });

  // Mensagens recebidas
  sock.ev.on('messages.upsert', async (upsert) => {
    console.log('📩 EVENTO RECEBIDO! type:', upsert.type, '| msgs:', upsert.messages?.length, '| keys:', Object.keys(upsert).join(','));
    const messages = upsert.messages || [];
    const type = upsert.type;
    // Em Baileys v7, type pode não existir - aceitar qualquer tipo
    if (type && type !== 'notify') return;

    // Carrega config atualizada a cada lote de mensagens
    const cfg = getConfig();
    const SESSION_TIMEOUT = (cfg.sessionTimeout || 10) * 60 * 1000;
    const msgs = cfg.messages || {};
    const menuOpts = cfg.menuOptions || {};
    const services = cfg.services || {};

    for (const msg of messages) {
      try {
        if (msg.key.fromMe) continue;

        const user = msg.key.remoteJid;
        if (!user || user === 'status@broadcast') continue;

        // Ignorar mensagens de grupos
        if (user.endsWith('@g.us')) continue;

        // Pause check
        if (botState.paused) continue;

        // Blacklist check
        const userNumber = user.replace('@s.whatsapp.net', '');
        if ((cfg.blacklist || []).length > 0 && cfg.blacklist.includes(userNumber)) {
          continue;
        }

        // Whitelist check (se não vazia, só permite listados)
        if ((cfg.whitelist || []).length > 0 && !cfg.whitelist.includes(userNumber)) {
          continue;
        }

        // Rate limit check
        if (!checkRateLimit(user)) {
          continue;
        }

        // Business hours check
        if (!isWithinBusinessHours()) {
          const offMsg = cfg.businessHours?.offlineMessage || msgs.outsideHours || 'Estamos fora do horário de atendimento.';
          await sock.sendMessage(user, { text: offMsg });
          continue;
        }

        // Contagem de estatísticas
        botState.stats.totalMessages = (botState.stats.totalMessages || 0) + 1;

        // Debug: ver mensagem bruta
        console.log('📨 MSG BRUTA:', JSON.stringify(msg.message, null, 2)?.substring(0, 500));

        // Extrair conteúdo da mensagem
        let content = msg.message;
        if (!content) continue;

        // Se tem messageContextInfo, extrair conteúdo real 
        if (content.senderKeyDistributionMessage || content.messageContextInfo) {
          content = extractMessageContent(content) || content;
        }

        // Ignorar mensagens de protocolo (não são mensagens reais do usuário)
        const skipTypes = ['senderKeyDistributionMessage', 'protocolMessage', 'messageContextInfo', 'reactionMessage', 'deviceSentMessage', 'fastRatchetKeySenderKeyDistributionMessage'];

        // Filtrar tipos de protocolo do conteúdo para encontrar o tipo real
        const contentKeys = Object.keys(content).filter(k => !skipTypes.includes(k));
        const contentType = contentKeys.length > 0 ? contentKeys[0] : null;
        
        console.log('📝 CONTENT TYPE:', contentType, '| KEYS:', Object.keys(content).join(', '));
        if (!contentType) continue;

        let text = '';
        if (contentType === 'conversation') {
          text = content.conversation;
        } else if (contentType === 'extendedTextMessage') {
          text = content.extendedTextMessage?.text || '';
        } else if (contentType === 'buttonsResponseMessage') {
          text = content.buttonsResponseMessage?.selectedButtonId || '';
        } else if (contentType === 'listResponseMessage') {
          text = content.listResponseMessage?.singleSelectReply?.selectedRowId || '';
        } else if (contentType === 'templateButtonReplyMessage') {
          text = content.templateButtonReplyMessage?.selectedId || '';
        }

        text = text.trim();
        const textLower = text.toLowerCase();
        const hasMedia = contentType === 'imageMessage';

        // cria sessão se não existir
        if (!sessions[user]) {
          sessions[user] = { step: 0 };
        }

        const session = sessions[user];
        refreshTimeout(user);

        // indicador "digitando..." com delay configurável
        await sendPresence(user);
        const typingDelay = cfg.typingDelay || 0;
        if (typingDelay > 0) await new Promise(r => setTimeout(r, typingDelay));

        console.log(`Mensagem de ${user}: ${text || (hasMedia ? '[IMAGEM]' : '[OUTRO]')}`);

        // COMANDO CANCELAR / VOLTAR
        const cancelWords = cfg.cancelKeywords || ['cancelar', 'voltar', 'sair', 'menu', '0'];
        if (cancelWords.includes(textLower) && session.step !== 0) {
          resetSession(user);
          refreshTimeout(user);
          await sendText(user, msgs.resetMessage || '🔄 Atendimento reiniciado!\n\nEnvie *oi* para começar novamente.');
          continue;
        }

        // INICIO - Menu Principal
        const greetExact = cfg.greetingKeywords || ['oi', 'olá', 'ola', 'oii', 'teste', 'testar'];
        const greetPartial = cfg.greetingPartialKeywords || ['valor', 'plano'];
        const isGreeting = greetExact.includes(textLower) || greetPartial.some(w => textLower.includes(w));
        if (isGreeting) {
          session.step = 1;
          await sendText(user, msgs.welcome || 'Bem-vindo! Envie o número da opção desejada.');
          continue;
        }

        // MENU PRINCIPAL - Opção 1: IPTV
        if (session.step === 1 && textLower === '1' && menuOpts.iptv !== false) {
          session.step = 10;
          await sendText(user, msgs.iptv || 'Escolha: 1) Testar 2) Assinar');
          continue;
        }

        // MENU PRINCIPAL - Opções 2, 3, 4: Serviços
        if (session.step === 1 && ['2', '3', '4'].includes(textLower)) {
          const optMap = { '2': 'sites', '3': 'bots', '4': 'sistemas' };
          if (menuOpts[optMap[textLower]] === false) continue;
          session.serviceType = services[textLower] || 'Serviço';
          session.step = 20;
          const svcMsg = (msgs.serviceAskName || '🔧 *{service}*\n\nQual o seu *nome*?').replace(/\{service\}/g, session.serviceType);
          await sendText(user, svcMsg);
          continue;
        }

        // MENU PRINCIPAL - Opção 5: CreditoPro
        if (session.step === 1 && textLower === '5' && menuOpts.creditoPro !== false) {
          session.step = 30;
          await sendText(user, msgs.creditoProAskName || '💳 *CréditoPro*\n\nQual o seu *nome*?');
          continue;
        }

        // MENU PRINCIPAL - Opção 6: Falar com atendente
        if (session.step === 1 && textLower === '6' && menuOpts.atendente !== false) {
          logAtendimento(user, 'ATENDENTE', 'Cliente solicitou atendimento humano');
          session.step = 0;
          await sendText(user, msgs.attendant || '👤 Um atendente entrará em contato em breve.');
          continue;
        }

        // === FLUXO CREDITOPRO ===

        // CREDITOPRO - Coletando nome
        if (session.step === 30) {
          session.name = text;
          session.step = 31;
          const emailMsg = (msgs.creditoProAskEmail || 'Prazer, *{name}*! 😄\n\nAgora me informe seu *e-mail*:').replace(/\{name\}/g, text);
          await sendText(user, emailMsg);
          continue;
        }

        // CREDITOPRO - Coletando email e criando conta
        if (session.step === 31) {
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          if (!emailRegex.test(text)) {
            await sendText(user, '❌ E-mail inválido. Por favor, digite um *e-mail válido*:');
            continue;
          }

          session.email = text;
          await sendText(user, '⏳ Criando sua conta no *CréditoPro*... Aguarde!');
          await sendPresence(user);

          try {
            const result = await createCreditoProUser(session.email, session.name);
            logAtendimento(user, 'CREDITOPRO', `Nome: ${session.name} | Email: ${session.email}`);
            session.step = 0;

            const userEmail = result.user?.email || session.email;
            const passInfo = result.generatedPassword || result.password || 'Verifique seu e-mail';

            const cpMsg = (msgs.creditoProSuccess || '✅ Conta criada!\n📧 E-mail: *{email}*\n🔑 Senha: *{password}*')
              .replace(/\{email\}/g, userEmail)
              .replace(/\{password\}/g, passInfo);
            await sendText(user, cpMsg);
          } catch (error) {
            console.error('Erro CreditoPro:', error.message);
            session.step = 0;
            await sendText(user, '❌ Ocorreu um erro ao criar sua conta no CréditoPro. Tente novamente mais tarde.');
          }
          continue;
        }

        // === FLUXO DE SERVIÇOS ===

        // SERVIÇO - Coletando nome
        if (session.step === 20) {
          session.name = text;
          session.step = 21;
          const descMsg = (msgs.serviceAskDescription || 'Prazer, *{name}*! Descreva o que precisa para *{service}*:')
            .replace(/\{name\}/g, text)
            .replace(/\{service\}/g, session.serviceType);
          await sendText(user, descMsg);
          continue;
        }

        // SERVIÇO - Coletando descrição do projeto
        if (session.step === 21) {
          session.description = text;
          logAtendimento(user, session.serviceType.toUpperCase(), `Nome: ${session.name} | Descrição: ${session.description}`);
          session.step = 0;
          const svcSuccessMsg = (msgs.serviceSuccess || '✅ Pedido registrado!\n• Serviço: *{service}*\n• Nome: *{name}*\n• Descrição: _{description}_')
            .replace(/\{service\}/g, session.serviceType)
            .replace(/\{name\}/g, session.name)
            .replace(/\{description\}/g, session.description);
          await sendText(user, svcSuccessMsg);
          continue;
        }

        // === FLUXO IPTV ===

        // IPTV - ACEITOU TESTE
        if (session.step === 10 && textLower === '1') {
          // Verifica limite de testes por número
          const testLimit = cfg.testLimitPerNumber || 1;
          const userTests = Object.values(testHistory).filter((v, i, a) => {
            // conta quantos testes esse user já fez
            return false; // placeholder
          });
          if (testHistory[user]) {
            const quando = new Date(testHistory[user]).toLocaleString('pt-BR');
            const alreadyMsg = (msgs.testAlreadyDone || '⚠️ Você já realizou um teste em *{date}*.').replace(/\{date\}/g, quando);
            await sendText(user, alreadyMsg);
            continue;
          }
          session.step = 6;
          await sendText(user, msgs.askName || '😄 Qual o seu *nome*?');
          continue;
        }

        // IPTV - RECEBEU NOME
        if (session.step === 6) {
          session.name = text;
          session.step = 2;
          const brandMsg = (msgs.askBrand || 'Prazer, *{name}*! Qual a *marca ou modelo* da sua TV?').replace(/\{name\}/g, text);
          await sendText(user, brandMsg);
          continue;
        }

        // IPTV - QUER ASSINAR
        if (session.step === 10 && textLower === '2') {
          session.step = 0;
          await sendText(user, msgs.iptvPlans || '💳 Um atendente entrará em contato para finalizar!');
          continue;
        }

        // RECEBEU MARCA DA TV
        if (session.step === 2) {
          const system = detectSystem(textLower);

          if (system === 'incompativel' || system === 'downloader' || !system) {
            session.system = 'downloader';
            try {
              await sendPresence(user);
              const credentials = await createWplayTest(session.name);
              testHistory[user] = Date.now();
              botState.stats.tests = (botState.stats.tests || 0) + 1;
              scheduleFollowUp(user);
              logAtendimento(user, 'DOWNLOADER', `Nome: ${session.name} | TV: ${text} | User: ${credentials.username}`);
              session.step = 0;

              const accessInfo = credentials.access_code
                ? `\n🔢 Código de acesso: *${credentials.access_code}*`
                : '';

              const dlMsg = (msgs.downloaderSuccess || 'Dados: {username} / {password}')
                .replace(/\{brand\}/g, text)
                .replace(/\{username\}/g, credentials.username)
                .replace(/\{password\}/g, credentials.password)
                .replace(/\{accessInfo\}/g, accessInfo);
              await sendText(user, dlMsg);
            } catch (error) {
              console.error('Erro ao criar teste Downloader:', error.message);
              await sendText(user, msgs.errorGeneric || '❌ Ocorreu um erro ao criar seu teste.');
            }
            continue;
          }

          if (system === 'roku') {
            session.system = 'roku';
            try {
              await sendPresence(user);
              const credentials = await createWplayTest(session.name);
              testHistory[user] = Date.now();
              botState.stats.tests = (botState.stats.tests || 0) + 1;
              scheduleFollowUp(user);
              logAtendimento(user, 'ROKU', `Nome: ${session.name} | User: ${credentials.username}`);
              session.step = 0;

              const accessInfo = credentials.access_code
                ? `\n🔢 Código de acesso: ${credentials.access_code}`
                : '';

              const rkMsg = (msgs.rokuSuccess || 'Dados: {username} / {password}')
                .replace(/\{username\}/g, credentials.username)
                .replace(/\{password\}/g, credentials.password)
                .replace(/\{accessInfo\}/g, accessInfo);
              await sendText(user, rkMsg);
            } catch (error) {
              console.error('Erro ao criar teste Roku:', error.message);
              await sendText(user, msgs.errorGeneric || '❌ Ocorreu um erro ao criar seu teste.');
            }
            continue;
          }

          if (system === 'android') {
            session.step = 3;
            session.system = 'android';
            await sendText(user, msgs.androidDetected || '✅ Sua TV usa *Android*! Envie uma foto do MAC.');
            continue;
          }

          // Qualquer outra marca não prevista já foi tratada acima (downloader)
        }

        // RECEBEU FOTO COM MAC
        if (session.step === 3 && hasMedia) {
          await sendText(user, '📸 Foto recebida! Aguarde enquanto extraímos o MAC...');
          await sendPresence(user);

          let buffer;
          try {
            const stream = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
            buffer = stream;
          } catch (e) {
            console.error('Erro ao baixar mídia:', e.message);
            await sendText(user, '❌ Erro ao baixar a imagem. Envie novamente ou digite o MAC manualmente (formato: XX:XX:XX:XX:XX:XX)');
            continue;
          }

          const Tesseract = require('tesseract.js');
          const tempPath = path.join(__dirname, `mac_temp_${Date.now()}.jpg`);
          fs.writeFileSync(tempPath, buffer);

          try {
            const result = await Tesseract.recognize(tempPath, 'eng');
            const textOCR = result.data.text;
            const macMatch = textOCR.match(/([0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}/);

            if (!macMatch) {
              session.step = 3;
              await sendText(user, '❌ Não consegui identificar o MAC na imagem.\n\nEnvie outra *foto mais nítida* ou digite o MAC manualmente (formato: XX:XX:XX:XX:XX:XX)');
              continue;
            }

            const mac = macMatch[0].replace(/-/g, ':').toUpperCase();

            await sendPresence(user);
            const credentials = await createOkraTest(session.name);
            await registerMac(mac, credentials.username, credentials.password, session.name);

            testHistory[user] = Date.now();
            botState.stats.tests = (botState.stats.tests || 0) + 1;
            scheduleFollowUp(user);
            logAtendimento(user, 'ANDROID', `Nome: ${session.name} | MAC: ${mac} | User: ${credentials.username}`);
            session.step = 0;

            const andMsg = (msgs.androidSuccess || '✅ Teste criado! MAC: *{mac}*').replace(/\{mac\}/g, mac);
            await sendText(user, andMsg);
          } catch (error) {
            console.error('Erro OCR:', error.message);
            session.step = 3;
            await sendText(user, '❌ Erro ao processar a imagem. Envie outra foto ou digite o MAC manualmente (formato: XX:XX:XX:XX:XX:XX)');
          } finally {
            try { fs.unlinkSync(tempPath); } catch (e) {}
          }
          continue;
        }

        // RECEBEU MAC DIGITADO (fallback)
        if (session.step === 3 && !hasMedia) {
          if (validateMac(text)) {
            const mac = text.toUpperCase();
            try {
              await sendPresence(user);
              const credentials = await createOkraTest(session.name);
              await registerMac(mac, credentials.username, credentials.password, session.name);

              testHistory[user] = Date.now();
              botState.stats.tests = (botState.stats.tests || 0) + 1;
              scheduleFollowUp(user);
              logAtendimento(user, 'ANDROID', `Nome: ${session.name} | MAC: ${mac} | User: ${credentials.username}`);
              session.step = 0;

              await sendText(user, msgs.androidSuccessManual || '✅ Teste criado! Abra o Pop Player e aproveite.');
            } catch (error) {
              console.error('Erro ao processar teste:', error.message);
              session.step = 0;
              await sendText(user, '❌ Ocorreu um erro ao criar seu teste. Tente novamente mais tarde.');
            }
          } else {
            await sendText(user, '📸 Por favor, envie uma *foto da tela* mostrando o MAC do seu aparelho.\n\nOu digite o MAC manualmente (formato: XX:XX:XX:XX:XX:XX)');
          }
          continue;
        }

        // MENSAGEM NÃO RECONHECIDA
        if (session.step === 0) {
          await sendText(user, msgs.unknownMessage || '⚡ Envie *oi* para ver nossas opções!');
        }
      } catch (err) {
        console.error('Erro ao processar mensagem:', err.message);
      }
    }
  });
}

// Iniciar painel e bot
startPanel();
startBot().catch(err => {
  console.error('Erro fatal ao iniciar bot:', err.message);
  setTimeout(() => startBot().catch(console.error), 10000);
});

// Evitar que erros não tratados matem o processo
process.on('uncaughtException', (err) => {
  console.error('⚠️ Erro não capturado:', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('⚠️ Promise rejeitada:', err?.message || err);
});