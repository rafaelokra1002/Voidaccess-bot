require('dotenv').config();
const { registerMac } = require('./services/pop.service');

async function testarPop() {
  console.log('=== TESTANDO POP ===');
  try {
    // Usa um MAC fictício e credenciais do último teste Okra
    const result = await registerMac('00:1A:79:AA:BB:CC', '875985', '704498', 'teste-bot');
    console.log('Pop OK:', JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('Pop ERRO:', error.message);
  }
}

testarPop();
