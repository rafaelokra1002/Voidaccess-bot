
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const API_URL = process.env.WPLAY_API_URL;
const getToken = require('./wplay.token');

function getWplayConfig() {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'config.json'), 'utf-8'));
  return cfg.wplay || {};
}

async function createTest(name) {
  try {
    const wplayCfg = getWplayConfig();
    const token = await getToken();
    const response = await axios.post(
      `${API_URL}/test`,
      {
        notes: name || '',
        package_p2p: wplayCfg.packageP2P || '64399dca5ea59e8a1de2b083',
        package_iptv: wplayCfg.packageIPTV || '30',
        testDuration: wplayCfg.testDuration || 4,
        krator_package: wplayCfg.kratorPackage || '1',
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const { username, password, access_code } = response.data;
    console.log('[WPLAY] Resposta completa:', JSON.stringify(response.data));
    console.log('[WPLAY] Teste criado - User:', username, 'Pass:', password, 'Code:', access_code);
    return { username, password, access_code };
  } catch (error) {
    const message = error.response?.data?.message || error.message;
    throw new Error(`Erro ao criar teste: ${message}`);
  }
}

module.exports = { createTest };
