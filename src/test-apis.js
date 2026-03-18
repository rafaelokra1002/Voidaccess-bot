require('dotenv').config();
const { createTest: createOkraTest } = require('./services/okra.service');
const { createTest: createWplayTest } = require('./services/wplay.service');

async function testarAPIs() {
  console.log('=== TESTANDO WPLAY ===');
  try {
    const wplay = await createWplayTest();
    console.log('Wplay OK:', JSON.stringify(wplay, null, 2));
  } catch (error) {
    console.error('Wplay ERRO:', error.message);
  }

  console.log('\n=== TESTANDO OKRA TV ===');
  try {
    const okra = await createOkraTest();
    console.log('Okra OK:', JSON.stringify(okra, null, 2));
  } catch (error) {
    console.error('Okra ERRO:', error.message);
  }
}

testarAPIs();
