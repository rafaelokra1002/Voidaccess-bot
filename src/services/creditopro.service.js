const axios = require('axios');

const API_URL = 'https://creditopro-api.onrender.com/api/bot/create-user';
const API_KEY = process.env.CREDITOPRO_API_KEY;

async function createUser(email, name) {
  try {
    const response = await axios.post(
      API_URL,
      {
        email,
        name: name || '',
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Bot-API-Key': API_KEY,
        },
      }
    );

    console.log('[CREDITOPRO] Resposta:', JSON.stringify(response.data));
    return response.data;
  } catch (error) {
    const message = error.response?.data?.message || error.response?.data?.error || error.message;
    throw new Error(`Erro CreditoPro: ${message}`);
  }
}

module.exports = { createUser };
