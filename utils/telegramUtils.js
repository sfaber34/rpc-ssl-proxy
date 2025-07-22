import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";

dotenv.config();

// Initialize Telegram bot with error handling
let telegramBot = null;
let TELEGRAM_CHAT_IDS = [];

try {
  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  if (TELEGRAM_BOT_TOKEN) {
    telegramBot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });
    TELEGRAM_CHAT_IDS = process.env.TELEGRAM_CHAT_IDS
      ? process.env.TELEGRAM_CHAT_IDS.split(",").map((id) => id.trim())
      : [];
  } else {
    console.warn('⚠️  TELEGRAM_BOT_TOKEN not found in environment variables - Telegram alerts disabled');
  }
} catch (error) {
  console.error('❌ Failed to initialize Telegram bot:', error.message);
  telegramBot = null;
}

function sendTelegramAlert(message, errorCode) {
  // Early return if Telegram is not configured
  if (!telegramBot || TELEGRAM_CHAT_IDS.length === 0) {
    console.log('📝 Telegram alert (not sent - not configured):', message.substring(0, 100) + '...');
    return;
  }

  TELEGRAM_CHAT_IDS.forEach((chatId) => {
    try {
      telegramBot
        .sendMessage(chatId, message)
        .then(() => console.log(`✅ Telegram alert sent to ${chatId}!`))
        .catch((err) => {
          console.error(`❌ Telegram alert error for ${chatId}:`, err.message);
          // Don't throw - just log the error
        });
    } catch (error) {
      console.error(`❌ Failed to send Telegram alert to ${chatId}:`, error.message);
      // Don't throw - just log the error
    }
  });
}

export { sendTelegramAlert }; 