import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import fs from "fs";
import express from "express";
import TelegramBot from "node-telegram-bot-api";

const app = express();
const PORT = process.env.PORT || 3000;

// إعدادات التلجرام
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MAGIC_EDEN_API_KEY = process.env.MAGIC_EDEN_API_KEY;

if (!TELEGRAM_BOT_TOKEN || !MAGIC_EDEN_API_KEY) {
  console.error("❌ يرجى تعيين TELEGRAM_BOT_TOKEN و MAGIC_EDEN_API_KEY في متغيرات البيئة");
  process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const MAGIC_EDEN_BASE_URL = "https://api-mainnet.magiceden.dev/v2";

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// دالة لاستخراج العناوين والمفاتيح من النص
function extractWalletsFromText(text) {
  const lines = text.split('\n');
  const wallets = [];

  lines.forEach(line => {
    const trimmedLine = line.trim();
    if (!trimmedLine) return;

    // البحث عن عناوين Solana (32-44 حرف)
    const solanaAddressRegex = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
    const addresses = trimmedLine.match(solanaAddressRegex);

    if (addresses) {
      addresses.forEach(address => {
        if (address.length >= 32 && address.length <= 44) {
          wallets.push({
            address: address,
            privateKey: "غير متوفر",
            hasPrivateKey: false,
            source: 'address'
          });
        }
      });
    }

    // البحث عن مفاتيح خاصة base58
    try {
      const secretKey = bs58.decode(trimmedLine);
      if (secretKey.length === 64) {
        const keypair = Keypair.fromSecretKey(secretKey);
        wallets.push({
          address: keypair.publicKey.toBase58(),
          privateKey: trimmedLine,
          hasPrivateKey: true,
          source: 'privateKey'
        });
      }
    } catch (error) {
      // ليس مفتاح خاص صالح
    }
  });

  return wallets;
}

function validateInput(input) {
  const trimmedInput = input.trim();
  if (!trimmedInput) return null;

  try {
    const secretKey = bs58.decode(trimmedInput);
    if (secretKey.length === 64) {
      const keypair = Keypair.fromSecretKey(secretKey);
      return {
        address: keypair.publicKey.toBase58(),
        privateKey: trimmedInput,
        hasPrivateKey: true,
        source: 'privateKey'
      };
    }
  } catch (error) {}

  if (trimmedInput.length >= 32 && trimmedInput.length <= 44) {
    return {
      address: trimmedInput,
      privateKey: "غير متوفر",
      hasPrivateKey: false,
      source: 'address'
    };
  }

  return null;
}

async function getWalletActivity(walletAddress) {
  try {
    const url = `${MAGIC_EDEN_BASE_URL}/wallets/${walletAddress}/activities?offset=0&limit=20`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${MAGIC_EDEN_API_KEY}` },
    });
    return response.ok ? await response.json() : [];
  } catch (e) {
    return [];
  }
}

async function getWalletTokens(walletAddress) {
  try {
    const url = `${MAGIC_EDEN_BASE_URL}/wallets/${walletAddress}/tokens`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${MAGIC_EDEN_API_KEY}` },
    });
    return response.ok ? await response.json() : [];
  } catch (e) {
    return [];
  }
}

async function getEscrowBalance(walletAddress) {
  try {
    const url = `${MAGIC_EDEN_BASE_URL}/wallets/${walletAddress}/escrow_balance`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${MAGIC_EDEN_API_KEY}` }
    });
    if (!response.ok) return 0;
    const data = await response.json();
    return typeof data === "number" ? data : (data?.sol || 0);
  } catch {
    return 0;
  }
}

// الاستعلامات الجديدة مع تصفية العروض النشطة فقط
async function getOffersMade(walletAddress) {
  try {
    const url = `${MAGIC_EDEN_BASE_URL}/wallets/${walletAddress}/offers_made`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${MAGIC_EDEN_API_KEY}` },
    });

    if (!response.ok) return [];

    const allOffers = await response.json();

    // تصفية العروض النشطة فقط
    const activeOffers = allOffers.filter(offer => 
      offer && 
      offer.status === 'active' && // العروض النشطة فقط
      !offer.cancelledAt && // لم يتم إلغاؤها
      (!offer.expiresAt || new Date(offer.expiresAt) > new Date()) // لم تنته صلاحيتها
    );

    return activeOffers;
  } catch (e) {
    return [];
  }
}

async function getOffersReceived(walletAddress) {
  try {
    const url = `${MAGIC_EDEN_BASE_URL}/wallets/${walletAddress}/offers_received`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${MAGIC_EDEN_API_KEY}` },
    });

    if (!response.ok) return [];

    const allOffers = await response.json();

    // تصفية العروض النشطة فقط
    const activeOffers = allOffers.filter(offer => 
      offer && 
      offer.status === 'active' && // العروض النشطة فقط
      !offer.cancelledAt && // لم يتم إلغاؤها
      (!offer.expiresAt || new Date(offer.expiresAt) > new Date()) // لم تنته صلاحيتها
    );

    return activeOffers;
  } catch (e) {
    return [];
  }
}

function analyzeTradingActivity(activity) {
  if (!Array.isArray(activity)) {
    return { hasTrading: false, recentActivity: [], count: 0 };
  }

  const tradingActivities = activity.filter(item => 
    item && ['buyNow', 'executeSale', 'acceptOffer', 'list', 'placeOffer'].includes(item.type)
  );

  const hasTrading = tradingActivities.length > 0;
  const recentActivity = tradingActivities.slice(0, 5);

  return { hasTrading, recentActivity, count: tradingActivities.length };
}

function findListedTokens(tokens) {
  if (!Array.isArray(tokens)) return [];

  // تصفية الـ NFTs المعروضة حالياً والنشطة
  return tokens.filter(token => 
    token && (
      token.listStatus === 'listed' ||
      token.listed === true ||
      token.onMarket === true ||
      (token.price && token.price > 0) ||
      (token.listPrice && token.listPrice > 0)
    )
  );
}

// دالة لحساب إجمالي قيمة العروض
function calculateOffersTotal(offers) {
  if (!Array.isArray(offers)) return 0;

  return offers.reduce((total, offer) => {
    const price = offer.price || offer.offerPrice || 0;
    return total + (parseFloat(price) || 0);
  }, 0);
}

async function checkWallet(walletAddress) {
  try {
    const [activity, tokens, escrowBalance, offersMade, offersReceived] = await Promise.all([
      getWalletActivity(walletAddress),
      getWalletTokens(walletAddress),
      getEscrowBalance(walletAddress),
      getOffersMade(walletAddress),
      getOffersReceived(walletAddress)
    ]);

    const { hasTrading, recentActivity, count: tradingCount } = analyzeTradingActivity(activity);
    const listedTokens = findListedTokens(tokens);
    const hasListed = listedTokens.length > 0;
    const hasOffersMade = Array.isArray(offersMade) && offersMade.length > 0;
    const hasOffersReceived = Array.isArray(offersReceived) && offersReceived.length > 0;

    // حساب إجمالي قيمة العروض
    const offersMadeTotal = calculateOffersTotal(offersMade);
    const offersReceivedTotal = calculateOffersTotal(offersReceived);

    return {
      address: walletAddress,
      activity: activity || [],
      tokens: tokens || [],
      escrowBalance: escrowBalance || 0,
      offersMade: offersMade || [],
      offersReceived: offersReceived || [],
      hasTrading,
      tradingCount,
      recentActivity: recentActivity || [],
      hasListed,
      listedCount: listedTokens.length,
      listedTokens: listedTokens, // عرض جميع الـ NFTs المعروضة
      hasOffersMade,
      offersMadeCount: hasOffersMade ? offersMade.length : 0,
      offersMadeTotal: offersMadeTotal,
      hasOffersReceived,
      offersReceivedCount: hasOffersReceived ? offersReceived.length : 0,
      offersReceivedTotal: offersReceivedTotal
    };
  } catch (e) {
    throw new Error(`فشل في فحص المحفظة: ${e.message}`);
  }
}

function generateMarkdownResult(walletInfo) {
  const {
    address,
    privateKey,
    hasTrading,
    tradingCount,
    hasListed,
    listedCount,
    escrowBalance,
    hasOffersMade,
    offersMadeCount,
    offersMadeTotal,
    hasOffersReceived,
    offersReceivedCount,
    offersReceivedTotal,
    recentActivity,
    listedTokens,
    offersMade,
    offersReceived
  } = walletInfo;

  let message = `🎯 *نتيجة فحص المحفظة*\n\n`;

  // العنوان مع إمكانية النسخ
  message += `📍 *العنوان:*\n\`${address}\`\n\n`;

  // المفتاح الخاص إذا كان متوفر
  if (privateKey !== "غير متوفر") {
    message += `🔑 *المفتاح الخاص:*\n\`${privateKey}\`\n\n`;
  }

  // النتائج مع علامات
  message += `📊 *نتائج الفحص:*\n`;
  message += `${hasTrading ? "✅" : "❌"} *البيع والشراء:* ${tradingCount} عملية\n`;
  message += `${hasListed ? "✅" : "❌"} *المعروض للبيع:* ${listedCount} NFT\n`;
  message += `${escrowBalance > 0 ? "✅" : "❌"} *رصيد الضمان:* ${escrowBalance} SOL\n`;
  message += `${hasOffersMade ? "✅" : "❌"} *العروض المقدمة:* ${offersMadeCount} عرض نشط (${offersMadeTotal.toFixed(4)} SOL)\n`;
  message += `${hasOffersReceived ? "✅" : "❌"} *العروض المستلمة:* ${offersReceivedCount} عرض نشط (${offersReceivedTotal.toFixed(4)} SOL)\n\n`;

  // آخر الأنشطة إذا وجدت
  if (recentActivity.length > 0) {
    message += `📈 *آخر الأنشطة:*\n`;
    recentActivity.forEach((act, i) => {
      const price = act.price ? `${act.price} SOL` : 'N/A';
      const type = act.type || 'unknown';
      message += `${i + 1}. ${type} - ${price}\n`;
    });
    message += `\n`;
  }

  // NFTs المعروضة إذا وجدت - عرض جميعها
  if (listedTokens.length > 0) {
    message += `🖼️ *NFTs المعروضة (${listedCount}):*\n`;
    listedTokens.forEach((nft, i) => {
      const name = nft.name || nft.title || 'Unknown';
      const price = nft.price || nft.listPrice || 'N/A';
      message += `${i + 1}. ${name} - ${price} SOL\n`;
    });
    message += `\n`;
  }

  // العروض المقدمة إذا وجدت
  if (offersMade.length > 0) {
    message += `💰 *العروض المقدمة (${offersMadeCount}):*\n`;
    offersMade.forEach((offer, i) => {
      const tokenName = offer.token?.name || offer.collection?.name || 'Unknown';
      const price = offer.price || offer.offerPrice || 'N/A';
      message += `${i + 1}. ${tokenName} - ${price} SOL\n`;
    });
    message += `*الإجمالي: ${offersMadeTotal.toFixed(4)} SOL*\n\n`;
  }

  // العروض المستلمة إذا وجدت
  if (offersReceived.length > 0) {
    message += `💎 *العروض المستلمة (${offersReceivedCount}):*\n`;
    offersReceived.forEach((offer, i) => {
      const tokenName = offer.token?.name || offer.collection?.name || 'Unknown';
      const price = offer.price || offer.offerPrice || 'N/A';
      message += `${i + 1}. ${tokenName} - ${price} SOL\n`;
    });
    message += `*الإجمالي: ${offersReceivedTotal.toFixed(4)} SOL*\n\n`;
  }

  // روابط سريعة
  message += `🔗 *روابط سريعة:*\n`;
  message += `[عرض على Magic Eden](https://magiceden.io/u/${address})\n`;
  message += `[عرض على Solscan](https://solscan.io/account/${address})\n\n`;

  message += `⏰ *وقت الفحص:* ${new Date().toLocaleString('ar-EG')}`;

  return message;
}

// معالجة رسائل التلجرام
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text) return;

  // رسالة الترحيب
  if (text === '/start' || text === '/help') {
    const welcomeMessage = `
🎯 *مرحباً بك في بوت فحص محافظ Magic Eden*

*📝 كيفية الاستخدام:*
• أرسل عنوان محفظة Solana
• أو أرسل المفتاح الخاص (base58)
• أو أرسل نص يحتوي على عدة عناوين

*🔍 ما يتم فحصه:*
✅ نشاط البيع والشراء
✅ NFTs المعروضة للبيع (النشطة فقط)  
✅ رصيد الضمان (Escrow)
✅ العروض المقدمة والمستلمة (النشطة فقط) مع قيمها

*⚡ مثال:*
\`9sBtLtMHWT1Srg1Q2wQMifuY6jrt14fPv7CTpyB6aHQE\`
    `;

    return bot.sendMessage(chatId, welcomeMessage, { 
      parse_mode: 'Markdown',
      reply_markup: {
        keyboard: [[{ text: '🎯 فحص محفظة' }]],
        resize_keyboard: true
      }
    });
  }

  // فحص المحفظة
  try {
    await bot.sendMessage(chatId, "🔍 جاري فحص المحفظة...", { parse_mode: 'Markdown' });

    // استخراج جميع العناوين والمفاتيح من النص
    const extractedWallets = extractWalletsFromText(text);

    if (extractedWallets.length === 0) {
      // إذا لم يتم استخراج أي عناوين، حاول معالجة النص كمدخل واحد
      const wallet = validateInput(text);
      if (!wallet) {
        return bot.sendMessage(chatId, "❌ *لم يتم العثور على عناوين صالحة*\nيرجى إرسال عنوان محفظة صالح أو مفتاح خاص", { 
          parse_mode: 'Markdown' 
        });
      }
      extractedWallets.push(wallet);
    }

    if (extractedWallets.length === 1) {
      // محفظة واحدة
      const wallet = extractedWallets[0];
      const result = await checkWallet(wallet.address);
      result.privateKey = wallet.privateKey;

      const message = generateMarkdownResult(result);

      await bot.sendMessage(chatId, message, { 
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      });
    } else {
      // عدة محافظ
      await bot.sendMessage(chatId, `🔍 تم العثور على ${extractedWallets.length} محفظة، جاري الفحص...`, { 
        parse_mode: 'Markdown' 
      });

      let resultsMessage = `🎯 *نتائج فحص ${extractedWallets.length} محفظة*\n\n`;

      for (let i = 0; i < Math.min(extractedWallets.length, 5); i++) {
        const wallet = extractedWallets[i];
        try {
          const result = await checkWallet(wallet.address);

          resultsMessage += `📍 *المحفظة ${i + 1}:* \`${wallet.address.substring(0, 12)}...\`\n`;
          resultsMessage += `🔄 تداول: ${result.tradingCount} | 🖼️ معروض: ${result.listedCount} | 💰 ضمان: ${result.escrowBalance} SOL\n`;
          resultsMessage += `📤 عروض: ${result.offersMadeCount} (${result.offersMadeTotal.toFixed(2)} SOL) | 📥 مستلم: ${result.offersReceivedCount} (${result.offersReceivedTotal.toFixed(2)} SOL)\n\n`;

          // تأخير بين الطلبات
          if (i < Math.min(extractedWallets.length, 5) - 1) {
            await sleep(500);
          }
        } catch (error) {
          resultsMessage += `📍 *المحفظة ${i + 1}:* \`${wallet.address.substring(0, 12)}...\` - ❌ خطأ\n\n`;
        }
      }

      if (extractedWallets.length > 5) {
        resultsMessage += `📝 *ملاحظة:* تم عرض أول 5 محافظ فقط من ${extractedWallets.length}`;
      }

      await bot.sendMessage(chatId, resultsMessage, { 
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      });
    }

  } catch (error) {
    console.error('Error:', error);
    await bot.sendMessage(chatId, `❌ *حدث خطأ أثناء الفحص*\n${error.message}`, { 
      parse_mode: 'Markdown' 
    });
  }
});

// صفحة ويب بسيطة للتحقق من حالة البوت
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html dir="rtl">
    <head>
        <meta charset="UTF-8">
        <title>بوت فحص محافظ Magic Eden</title>
        <style>
            body { 
                font-family: Arial, sans-serif; 
                text-align: center; 
                padding: 50px; 
                background: #f5f5f5;
            }
            .container {
                background: white;
                padding: 30px;
                border-radius: 10px;
                box-shadow: 0 2px 10px rgba(0,0,0,0.1);
                max-width: 600px;
                margin: 0 auto;
            }
            h1 { color: #333; }
            .status { 
                color: green; 
                font-weight: bold;
                font-size: 18px;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🤖 بوت فحص محافظ Magic Eden</h1>
            <p class="status">✅ البوت يعمل بشكل طبيعي</p>
            <p>استخدم بوت التلجرام لفحص محافظك</p>
            <p>📊 يتم فحص: نشاط التداول - NFTs المعروضة - رصيد الضمان - العروض النشطة</p>
            <hr>
            <p>⚡ Powered by Magic Eden API</p>
        </div>
    </body>
    </html>
  `);
});

// تشغيل السيرفر
app.listen(PORT, () => {
  console.log(`🚀 السيرفر يعمل على port ${PORT}`);
  console.log(`🌐 يمكنك زيارة: http://localhost:${PORT}`);
  console.log(`🤖 بوت التلجرام جاهز لاستقبال الرسائل`);
});

// معالجة الأخطاء غير المتوقعة
process.on('uncaughtException', (error) => {
  console.error('❌ خطأ غير متوقع:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ خطأ في Promise:', reason);
});