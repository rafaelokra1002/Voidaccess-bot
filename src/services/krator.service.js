const axios = require('axios');

const API_URL = process.env.WPLAY_API_URL;

// Cria usuário de teste no Krator (Roku TV)
async function createTest() {
  try {
    const response = await axios.post(`${API_URL}/krator/test`, {
      notes: '',
      package_p2p: '64399dca5ea59e8a1de2b083',
      package_iptv: '30',
      testDuration: 1,
      krator_package: '1',
      serviceId: '672b26efd46f330001c0a590',
    });

    const { username, password, access_code } = response.data;

    return { username, password, access_code };
  } catch (error) {
    const message = error.response?.data?.message || error.message;
    throw new Error(`Erro ao criar teste Krator: ${message}`);
  }
}

module.exports = { createTest };
