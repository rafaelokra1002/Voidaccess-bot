require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers, DisconnectReason, extractMessageContent, getContentType, downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const { createTest: createOkraTest } = require('./services/okra.service');
const { createTest: createWplayTest } = require('./services/wplay.service');
const { registerMac } = require('./services/pop.service');
const { createUser: createCreditoProUser } = require('./services/creditopro.service');
const validateMac = require('./utils/validateMac');

// sessões dos usuários
const sessions = {};

// controle de testes por número (limite 1 por número)
const testHistory = {};

// timeout de sessão (10 minutos)
const SESSION_TIMEOUT = 10 * 60 * 1000;

// arquivo de log
const LOG_FILE = path.join(__dirname, '..', 'atendimentos.log');

// Controle de reconexão
const MAX_RETRIES = 5;
let retryCount = 0;
let sock;

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
  sessions[user].timeout = setTimeout(async () => {
    if (sessions[user] && sessions[user].step !== 0) {
      await sock.sendMessage(user, { text: '⏰ Sua sessão expirou por inatividade. Envie *oi* para recomeçar!' });
      resetSession(user);
    }
  }, SESSION_TIMEOUT);
}

// Mapeamento de marcas para sistema
const TV_BRANDS = {
  'tcl': 'roku', 'hisense': 'roku', 'philco': 'roku', 'aoc': 'roku', 'semp': 'roku',
  'xiaomi': 'android', 'sony': 'android', 'philips': 'android', 'motorola': 'android',
  'jvc': 'android', 'toshiba': 'android', 'multilaser': 'android', 'nokia': 'android',
  'tv box': 'android', 'tvbox': 'android', 'mi box': 'android', 'mibox': 'android',
  'fire stick': 'android', 'firestick': 'android', 'fire tv': 'android',
  'samsung': 'downloader', 'lg': 'downloader', 'panasonic': 'downloader',
};

function detectSystem(brand) {
  const input = brand.toLowerCase();
  for (const [key, system] of Object.entries(TV_BRANDS)) {
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

    if (qr) {
      console.log('\n========================================');
      console.log('📲 ESCANEIE O QR CODE COM SEU WHATSAPP');
      console.log('========================================');
      console.log('1. Copie o texto abaixo');
      console.log('2. Acesse: https://qr.io/ ou https://www.qr-code-generator.com/');
      console.log('3. Cole o texto e gere o QR Code');
      console.log('4. Escaneie com WhatsApp > Dispositivos conectados > Conectar dispositivo');
      console.log('========================================');
      console.log('QR_TEXT_START');
      console.log(qr);
      console.log('QR_TEXT_END');
      console.log('========================================\n');
    }

    if (connection === 'open') {
      retryCount = 0;
      console.log('\n✅ Bot conectado ao WhatsApp!');
      console.log('⚡ VoidAccess Tech Bot - Baileys');
      console.log('📡 Pronto para receber mensagens!\n');
    }

    if (connection === 'close') {
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
        console.log('💀 Máximo de tentativas atingido. Reinicie o bot manualmente.');
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

    for (const msg of messages) {
      try {
        if (msg.key.fromMe) continue;

        const user = msg.key.remoteJid;
        if (!user || user === 'status@broadcast') continue;

        // Ignorar mensagens de grupos
        if (user.endsWith('@g.us')) continue;

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

        // indicador "digitando..."
        await sendPresence(user);

        console.log(`Mensagem de ${user}: ${text || (hasMedia ? '[IMAGEM]' : '[OUTRO]')}`);

        // COMANDO CANCELAR / VOLTAR
        if (['cancelar', 'voltar', 'sair', 'menu', '0'].includes(textLower) && session.step !== 0) {
          resetSession(user);
          refreshTimeout(user);
          await sendText(user, '🔄 Atendimento reiniciado!\n\nEnvie *oi* para começar novamente.');
          continue;
        }

        // INICIO - Menu Principal VoidAccess Tech
        if (textLower === 'oi' || textLower === 'olá' || textLower === 'ola' || textLower === 'oii'
          || textLower.includes('valor') || textLower.includes('plano')
          || textLower === 'teste' || textLower === 'testar') {
          session.step = 1;

          await sendText(user,
            `⚡ *Bem-vindo à VoidAccess Tech!*\n\nTrabalhamos com *IPTV, Sites, Bots e Sistemas* sob medida.\n\nQual o motivo do seu contato?\n\n1️⃣ 📺 IPTV\n2️⃣ 🌐 Criação de Sites\n3️⃣ 🤖 Bots / Automações\n4️⃣ 💻 Sistemas\n5️⃣ � Testar CréditoPro\n6️⃣ �👤 Falar com Atendente\n\n_Digite o número da opção desejada_`
          );
          continue;
        }

        // MENU PRINCIPAL - Opção 1: IPTV
        if (session.step === 1 && textLower === '1') {
          session.step = 10;

          await sendText(user,
            `📺 *IPTV - VoidAccess Tech*\n\nTemos os melhores canais, filmes e séries para você!\n\n💰 *Nossos planos:*\n• Mensal: *R$ 25,00*\n• Trimestral: *R$ 65,00*\n\n🔥 Quer fazer um *teste grátis* antes de assinar?\n\n1️⃣ ✅ Sim, quero testar!\n2️⃣ 💳 Quero assinar direto\n\n_Digite o número da opção_`
          );
          continue;
        }

        // MENU PRINCIPAL - Opções 2, 3, 4: Serviços
        if (session.step === 1 && ['2', '3', '4'].includes(textLower)) {
          const servicos = {
            '2': 'Criação de Sites',
            '3': 'Criação de Bots / Automações',
            '4': 'Desenvolvimento de Sistemas',
          };
          session.serviceType = servicos[textLower];
          session.step = 20;
          await sendText(user, `🔧 *${session.serviceType}*\n\nPara enviar seu pedido, preciso de algumas informações.\n\nQual o seu *nome*?`);
          continue;
        }

        // MENU PRINCIPAL - Opção 5: CreditoPro
        if (session.step === 1 && textLower === '5') {
          session.step = 30;
          await sendText(user, '💳 *CréditoPro*\n\nVamos criar sua conta de teste!\n\nQual o seu *nome*?');
          continue;
        }

        // MENU PRINCIPAL - Opção 6: Falar com atendente
        if (session.step === 1 && textLower === '6') {
          logAtendimento(user, 'ATENDENTE', 'Cliente solicitou atendimento humano');
          session.step = 0;
          await sendText(user, '👤 Certo! Um *atendente* entrará em contato em breve.\n\nObrigado por entrar em contato com a *VoidAccess Tech*! ⚡');
          continue;
        }

        // === FLUXO CREDITOPRO ===

        // CREDITOPRO - Coletando nome
        if (session.step === 30) {
          session.name = text;
          session.step = 31;
          await sendText(user, `Prazer, *${text}*! 😄\n\nAgora me informe seu *e-mail*:`);
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

            await sendText(user, `✅ *Conta CréditoPro criada com sucesso!*\n\n🌐 Acesse: https://creditoprocom.com/\n📧 E-mail: *${userEmail}*\n🔑 Senha: *${passInfo}*\n\nEnvie *oi* para voltar ao menu principal.`);
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
          await sendText(user, `Prazer, *${text}*! 😄\n\nAgora descreva brevemente o que você *precisa* para o seu projeto de *${session.serviceType}*:\n\n_(Ex: quero um site para minha loja, preciso de um bot para WhatsApp, etc.)_`);
          continue;
        }

        // SERVIÇO - Coletando descrição do projeto
        if (session.step === 21) {
          session.description = text;
          logAtendimento(user, session.serviceType.toUpperCase(), `Nome: ${session.name} | Descrição: ${session.description}`);
          session.step = 0;
          await sendText(user, `✅ *Pedido registrado com sucesso!*\n\n📋 *Resumo:*\n• Serviço: *${session.serviceType}*\n• Nome: *${session.name}*\n• Descrição: _${session.description}_\n\nUm *especialista* da VoidAccess Tech entrará em contato em breve para discutir seu projeto! ⚡\n\nObrigado pela confiança! 🙏`);
          continue;
        }

        // === FLUXO IPTV ===

        // IPTV - ACEITOU TESTE
        if (session.step === 10 && textLower === '1') {
          if (testHistory[user]) {
            const quando = new Date(testHistory[user]).toLocaleString('pt-BR');
            await sendText(user, `⚠️ Você já realizou um teste em *${quando}*.\n\nCada número tem direito a *1 teste gratuito*.\n\n💰 Gostou? Envie *2* para ver nossos planos de assinatura!`);
            continue;
          }
          session.step = 6;
          await sendText(user, '😄 Qual o seu *nome*?');
          continue;
        }

        // IPTV - RECEBEU NOME
        if (session.step === 6) {
          session.name = text;
          session.step = 2;
          await sendText(user, `Prazer, *${text}*! 😄\n\n📺 Qual a *marca ou modelo* da sua TV?\n\nExemplos: TCL, Xiaomi, Sony, Philips, AOC, Hisense, Philco, Semp, TV Box...\n\nDigite a marca:`);
          continue;
        }

        // IPTV - QUER ASSINAR
        if (session.step === 10 && textLower === '2') {
          session.step = 0;
          await sendText(user,
            `💳 Ótimo! Para assinar, escolha seu plano:\n\n1️⃣ 📅 Mensal (R$ 25,00)\n2️⃣ 📅 Trimestral (R$ 65,00)\n\n_Um atendente entrará em contato para finalizar!_`
          );
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
              logAtendimento(user, 'DOWNLOADER', `Nome: ${session.name} | TV: ${text} | User: ${credentials.username}`);
              session.step = 0;

              const accessInfo = credentials.access_code
                ? `\n🔢 Código de acesso: *${credentials.access_code}*`
                : '';

              await sendText(user, `📺 Para sua TV *${text}*, siga os passos abaixo:\n\n1️⃣ Baixe o app *Downloader* na loja de apps da sua TV\n2️⃣ Abra o app e digite o código: *3964281*\n3️⃣ *Aceite todas as permissões* que aparecerem\n4️⃣ O app *Xcloud* será instalado automaticamente!\n\nDepois de instalar, abra o *Xcloud* e use os dados abaixo:\n\n👤 Usuário: *${credentials.username}*\n🔑 Senha: *${credentials.password}*${accessInfo}\n\n⏰ Seu teste é válido por algumas horas. Aproveite!\n\nGostou? Envie "oi" para ver nossos planos! 😉`);
            } catch (error) {
              console.error('Erro ao criar teste Downloader:', error.message);
              await sendText(user, '❌ Ocorreu um erro ao criar seu teste. Tente novamente mais tarde.');
            }
            continue;
          }

          if (system === 'roku') {
            session.system = 'roku';
            try {
              await sendPresence(user);
              const credentials = await createWplayTest(session.name);
              testHistory[user] = Date.now();
              logAtendimento(user, 'ROKU', `Nome: ${session.name} | User: ${credentials.username}`);
              session.step = 0;

              const accessInfo = credentials.access_code
                ? `\n🔢 Código de acesso: ${credentials.access_code}`
                : '';

              await sendText(user, `✅ Sua TV usa *Roku OS*!\n\n📲 Baixe o app *Krator+* na sua Roku TV pela loja de apps.\n\nDepois de instalar, abra o app e use os dados abaixo:\n\n👤 Usuário: *${credentials.username}*\n🔑 Senha: *${credentials.password}*${accessInfo}\n\n⏰ Seu teste é válido por algumas horas. Aproveite!\n\nGostou? Envie "oi" para ver nossos planos! 😉`);
            } catch (error) {
              console.error('Erro ao criar teste Roku:', error.message);
              await sendText(user, '❌ Ocorreu um erro ao criar seu teste. Tente novamente mais tarde.');
            }
            continue;
          }

          if (system === 'android') {
            session.step = 3;
            session.system = 'android';
            await sendText(user, '✅ Sua TV usa *Android*!\n\n📲 Baixe o app *Pop Player* na sua TV pela Play Store.\n\nDepois de instalar, envie uma *foto da tela* mostrando o MAC do seu aparelho 📸');
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
            logAtendimento(user, 'ANDROID', `Nome: ${session.name} | MAC: ${mac} | User: ${credentials.username}`);
            session.step = 0;

            await sendText(user, `✅ *Teste criado com sucesso!*\n\nMAC detectado: *${mac}*\n\nAbra o app *Pop Player* na sua TV e faça o seguinte:\n1. *Feche e abra o app novamente*\n2. O MAC já está cadastrado!\n\n⏰ Seu teste é válido por algumas horas. Aproveite!\n\nGostou? Envie "oi" para ver nossos planos! 😉`);
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
              logAtendimento(user, 'ANDROID', `Nome: ${session.name} | MAC: ${mac} | User: ${credentials.username}`);
              session.step = 0;

              await sendText(user, `✅ *Teste criado com sucesso!*\n\nAbra o app *Pop Player* na sua TV e faça o seguinte:\n1. *Feche e abra o app novamente*\n2. O MAC já está cadastrado!\n\n⏰ Seu teste é válido por algumas horas. Aproveite!\n\nGostou? Envie "oi" para ver nossos planos! 😉`);
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
          await sendText(user, '⚡ Olá! Eu sou o assistente da *VoidAccess Tech*.\n\nTrabalhamos com IPTV, Sites, Bots e Sistemas.\n\nEnvie *oi* para ver nossas opções! 🚀');
        }
      } catch (err) {
        console.error('Erro ao processar mensagem:', err.message);
      }
    }
  });
}

// Iniciar bot
startBot().catch(err => {
  console.error('Erro fatal ao iniciar bot:', err.message);
  process.exit(1);
});