require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');
const { createTest: createOkraTest } = require('./services/okra.service');
const { createTest: createWplayTest } = require('./services/wplay.service');
const { registerMac } = require('./services/pop.service');
const validateMac = require('./utils/validateMac');

// === CONFIG ===
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_ID;
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'voidaccess_verify_2024';
const PORT = process.env.WEBHOOK_PORT || 3000;
const API_URL = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;

// === VALIDAÇÃO ===
if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
  console.error('❌ Configure WHATSAPP_TOKEN e WHATSAPP_PHONE_ID no .env');
  process.exit(1);
}

// === SESSÕES ===
const sessions = {};
const testHistory = {};
const SESSION_TIMEOUT = 10 * 60 * 1000;
const LOG_FILE = path.join(__dirname, '..', 'atendimentos.log');

// === LOGGING ===
function logAtendimento(user, tipo, detalhes) {
  const timestamp = new Date().toLocaleString('pt-BR');
  const line = `[${timestamp}] ${user} | ${tipo} | ${detalhes}\n`;
  fs.appendFileSync(LOG_FILE, line);
  console.log(`📋 LOG: ${line.trim()}`);
}

// === SESSÃO ===
function resetSession(user) {
  if (sessions[user]?.timeout) clearTimeout(sessions[user].timeout);
  sessions[user] = { step: 0 };
}

function refreshTimeout(user) {
  if (sessions[user]?.timeout) clearTimeout(sessions[user].timeout);
  sessions[user].timeout = setTimeout(async () => {
    if (sessions[user] && sessions[user].step !== 0) {
      await sendText(user, '⏰ Sua sessão expirou por inatividade. Envie *oi* para recomeçar!');
      resetSession(user);
    }
  }, SESSION_TIMEOUT);
}

// === MARCAS DE TV ===
const TV_BRANDS = {
  'tcl': 'roku', 'hisense': 'roku', 'philco': 'roku', 'aoc': 'roku', 'semp': 'roku',
  'xiaomi': 'android', 'sony': 'android', 'philips': 'android', 'motorola': 'android',
  'jvc': 'android', 'toshiba': 'android', 'multilaser': 'android', 'nokia': 'android',
  'tv box': 'android', 'tvbox': 'android', 'mi box': 'android', 'mibox': 'android',
  'fire stick': 'android', 'firestick': 'android', 'fire tv': 'android',
  'samsung': 'incompativel', 'lg': 'incompativel', 'panasonic': 'incompativel',
};

function detectSystem(brand) {
  const input = brand.toLowerCase();
  for (const [key, system] of Object.entries(TV_BRANDS)) {
    if (input.includes(key)) return system;
  }
  return null;
}

// =============================================
// === FUNÇÕES DE ENVIO - WhatsApp Cloud API ===
// =============================================

async function sendRequest(data) {
  try {
    await axios.post(API_URL, data, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
  } catch (error) {
    const msg = error.response?.data?.error?.message || error.message;
    console.error('❌ Erro ao enviar mensagem:', msg);
  }
}

async function sendText(to, text) {
  await sendRequest({
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text },
  });
}

async function sendButtons(to, bodyText, buttons) {
  await sendRequest({
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: buttons.map(b => ({
          type: 'reply',
          reply: { id: b.id, title: b.title },
        })),
      },
    },
  });
}

async function sendList(to, bodyText, buttonLabel, sections) {
  await sendRequest({
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: bodyText },
      action: {
        button: buttonLabel,
        sections,
      },
    },
  });
}

async function markAsRead(messageId) {
  try {
    await axios.post(API_URL, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
    }, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
  } catch (e) { /* ignore */ }
}

async function downloadMedia(mediaId) {
  // 1. Buscar URL do media
  const mediaInfo = await axios.get(`https://graph.facebook.com/v21.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });
  const mediaUrl = mediaInfo.data.url;

  // 2. Baixar o arquivo
  const response = await axios.get(mediaUrl, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    responseType: 'arraybuffer',
  });
  return Buffer.from(response.data);
}

// =============================================
// === EXPRESS SERVER (WEBHOOK) ===
// =============================================

const app = express();
app.use(express.json());

// Verificação do webhook (Meta envia GET para validar)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verificado com sucesso!');
    return res.status(200).send(challenge);
  }
  console.log('❌ Webhook verificação falhou');
  res.sendStatus(403);
});

// Receber mensagens
app.post('/webhook', async (req, res) => {
  // Responder 200 imediatamente (requisito do Meta)
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    if (!value?.messages) return;

    for (const msg of value.messages) {
      try {
        await processMessage(msg, value.contacts);
      } catch (err) {
        console.error('Erro ao processar mensagem:', err.message);
      }
    }
  } catch (err) {
    console.error('Erro no webhook:', err.message);
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', bot: 'VoidAccess Tech - Cloud API' });
});

// =============================================
// === PROCESSAMENTO DE MENSAGENS ===
// =============================================

async function processMessage(msg, contacts) {
  const user = msg.from;
  const messageId = msg.id;
  const msgType = msg.type;

  // Marcar como lida (✓✓ azul)
  await markAsRead(messageId);

  // Extrair texto ou resposta de botão/lista
  let text = '';
  let hasMedia = false;

  if (msgType === 'text') {
    text = msg.text?.body || '';
  } else if (msgType === 'interactive') {
    const interactive = msg.interactive;
    if (interactive.type === 'button_reply') {
      text = interactive.button_reply.id;
    } else if (interactive.type === 'list_reply') {
      text = interactive.list_reply.id;
    }
  } else if (msgType === 'image') {
    hasMedia = true;
  } else {
    // Ignorar outros tipos (reaction, sticker, etc.)
    return;
  }

  text = text.trim();
  const textLower = text.toLowerCase();

  // Criar sessão se não existir
  if (!sessions[user]) {
    sessions[user] = { step: 0 };
  }

  const session = sessions[user];
  refreshTimeout(user);

  const contactName = contacts?.[0]?.profile?.name || user;
  console.log(`📩 Mensagem de ${contactName} (${user}): ${text || (hasMedia ? '[IMAGEM]' : '[OUTRO]')}`);

  // === COMANDO CANCELAR / VOLTAR ===
  if (['cancelar', 'voltar', 'sair', 'menu', '0'].includes(textLower) && session.step !== 0) {
    resetSession(user);
    refreshTimeout(user);
    await sendText(user, '🔄 Atendimento reiniciado!\n\nEnvie *oi* para começar novamente.');
    return;
  }

  // === MENU PRINCIPAL ===
  if (session.step === 0 || textLower === 'oi' || textLower === 'olá' || textLower === 'ola' || textLower === 'oii'
    || textLower.includes('valor') || textLower.includes('plano')
    || textLower === 'teste' || textLower === 'testar') {

    if (textLower === '' && session.step !== 0) return;

    session.step = 1;
    await sendList(user,
      '⚡ *Bem-vindo à VoidAccess Tech!*\n\nTrabalhamos com *IPTV, Sites, Bots e Sistemas* sob medida.\n\nEscolha o motivo do seu contato:',
      '📋 Ver opções',
      [{
        title: 'Nossos Serviços',
        rows: [
          { id: 'menu_1', title: '📺 IPTV', description: 'Canais, filmes e séries' },
          { id: 'menu_2', title: '🌐 Criação de Sites', description: 'Sites profissionais sob medida' },
          { id: 'menu_3', title: '🤖 Bots / Automações', description: 'Bots para WhatsApp e mais' },
          { id: 'menu_4', title: '💻 Sistemas', description: 'Sistemas personalizados' },
          { id: 'menu_5', title: '👤 Falar com Atendente', description: 'Atendimento humano' },
        ],
      }]
    );
    return;
  }

  // === MENU PRINCIPAL - RESPOSTAS ===

  // IPTV
  if (session.step === 1 && (textLower === '1' || text === 'menu_1')) {
    session.step = 10;
    await sendButtons(user,
      '📺 *IPTV - VoidAccess Tech*\n\nTemos os melhores canais, filmes e séries!\n\n💰 *Nossos planos:*\n• Mensal: *R$ 25,00*\n• Trimestral: *R$ 65,00*\n\n🔥 Quer fazer um *teste grátis* antes de assinar?',
      [
        { id: 'iptv_test', title: '✅ Testar grátis!' },
        { id: 'iptv_subscribe', title: '💳 Quero assinar' },
      ]
    );
    return;
  }

  // Criação de Sites / Bots / Sistemas
  if (session.step === 1 && (['2', '3', '4'].includes(textLower) || ['menu_2', 'menu_3', 'menu_4'].includes(text))) {
    const servicos = {
      '2': 'Criação de Sites', 'menu_2': 'Criação de Sites',
      '3': 'Criação de Bots / Automações', 'menu_3': 'Criação de Bots / Automações',
      '4': 'Desenvolvimento de Sistemas', 'menu_4': 'Desenvolvimento de Sistemas',
    };
    session.serviceType = servicos[text] || servicos[textLower];
    session.step = 20;
    await sendText(user, `🔧 *${session.serviceType}*\n\nPara enviar seu pedido, preciso de algumas informações.\n\nQual o seu *nome*?`);
    return;
  }

  // Falar com Atendente
  if (session.step === 1 && (textLower === '5' || text === 'menu_5')) {
    logAtendimento(user, 'ATENDENTE', 'Cliente solicitou atendimento humano');
    session.step = 0;
    await sendText(user, '👤 Certo! Um *atendente* entrará em contato em breve.\n\nObrigado por entrar em contato com a *VoidAccess Tech*! ⚡');
    return;
  }

  // === FLUXO DE SERVIÇOS ===

  if (session.step === 20) {
    session.name = text;
    session.step = 21;
    await sendText(user, `Prazer, *${text}*! 😄\n\nAgora descreva brevemente o que você *precisa* para o seu projeto de *${session.serviceType}*:\n\n_(Ex: quero um site para minha loja, preciso de um bot para WhatsApp, etc.)_`);
    return;
  }

  if (session.step === 21) {
    session.description = text;
    logAtendimento(user, session.serviceType.toUpperCase(), `Nome: ${session.name} | Descrição: ${session.description}`);
    session.step = 0;
    await sendText(user, `✅ *Pedido registrado com sucesso!*\n\n📋 *Resumo:*\n• Serviço: *${session.serviceType}*\n• Nome: *${session.name}*\n• Descrição: _${session.description}_\n\nUm *especialista* da VoidAccess Tech entrará em contato em breve para discutir seu projeto! ⚡\n\nObrigado pela confiança! 🙏`);
    return;
  }

  // === FLUXO IPTV ===

  // IPTV - Teste
  if (session.step === 10 && (textLower === '1' || text === 'iptv_test')) {
    if (testHistory[user]) {
      const quando = new Date(testHistory[user]).toLocaleString('pt-BR');
      await sendText(user, `⚠️ Você já realizou um teste em *${quando}*.\n\nCada número tem direito a *1 teste gratuito*.\n\n💰 Gostou? Envie *oi* para ver nossos planos de assinatura!`);
      return;
    }
    session.step = 6;
    await sendText(user, '😄 Qual o seu *nome*?');
    return;
  }

  // IPTV - Nome
  if (session.step === 6) {
    session.name = text;
    session.step = 2;
    await sendText(user, `Prazer, *${text}*! 😄\n\n📺 Qual a *marca ou modelo* da sua TV?\n\nExemplos: TCL, Xiaomi, Sony, Philips, AOC, Hisense, Philco, Semp, TV Box...\n\nDigite a marca:`);
    return;
  }

  // IPTV - Assinar
  if (session.step === 10 && (textLower === '2' || text === 'iptv_subscribe')) {
    session.step = 0;
    await sendButtons(user,
      '💳 Ótimo! Escolha seu plano:',
      [
        { id: 'plan_monthly', title: '📅 Mensal R$25' },
        { id: 'plan_quarterly', title: '📅 Trimestral R$65' },
      ]
    );
    return;
  }

  // MARCA DA TV
  if (session.step === 2) {
    const system = detectSystem(textLower);

    if (system === 'incompativel') {
      session.step = 0;
      await sendText(user, '😕 Infelizmente TVs *Samsung, LG e Panasonic* usam sistema próprio e não são compatíveis diretamente.\n\n💡 Mas você pode usar um *TV Box* (Android) conectado na sua TV!\n\nSe tiver um TV Box, mande "oi" e selecione a opção de teste.');
      return;
    }

    if (system === 'roku') {
      session.system = 'roku';
      try {
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
      return;
    }

    if (system === 'android') {
      session.step = 3;
      session.system = 'android';
      await sendText(user, '✅ Sua TV usa *Android*!\n\n📲 Baixe o app *Pop Player* na sua TV pela Play Store.\n\nDepois de instalar, envie uma *foto da tela* mostrando o MAC do seu aparelho 📸');
      return;
    }

    // Marca não reconhecida
    await sendText(user, `🤔 Não reconheci a marca "*${text}*".\n\nPor favor, digite a marca da TV (ex: TCL, Xiaomi, Sony, AOC, Philco, TV Box...)`);
    return;
  }

  // RECEBEU FOTO COM MAC
  if (session.step === 3 && hasMedia) {
    await sendText(user, '📸 Foto recebida! Aguarde enquanto extraímos o MAC...');

    let buffer;
    try {
      buffer = await downloadMedia(msg.image.id);
    } catch (e) {
      console.error('Erro ao baixar mídia:', e.message);
      await sendText(user, '❌ Erro ao baixar a imagem. Envie novamente ou digite o MAC manualmente (formato: XX:XX:XX:XX:XX:XX)');
      return;
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
        return;
      }

      const mac = macMatch[0].replace(/-/g, ':').toUpperCase();

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
    return;
  }

  // MAC DIGITADO
  if (session.step === 3 && !hasMedia) {
    if (validateMac(text)) {
      const mac = text.toUpperCase();
      try {
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
    return;
  }

  // MENSAGEM NÃO RECONHECIDA
  if (session.step === 0) {
    await sendButtons(user,
      '⚡ Olá! Eu sou o assistente da *VoidAccess Tech*.\n\nTrabalhamos com IPTV, Sites, Bots e Sistemas.',
      [
        { id: 'start', title: '🚀 Ver opções' },
      ]
    );
  }
}

// === INICIAR SERVIDOR ===
app.listen(PORT, () => {
  console.log('\n⚡ VoidAccess Tech Bot - WhatsApp Cloud API');
  console.log(`✅ Webhook rodando na porta ${PORT}`);
  console.log(`📡 URL do webhook: http://SEU_IP:${PORT}/webhook`);
  console.log(`🔑 Verify Token: ${VERIFY_TOKEN}`);
  console.log('📱 Pronto para receber mensagens!\n');
});
