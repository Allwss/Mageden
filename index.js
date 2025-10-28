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

// دالة رصيد الضمان الأصلية التي كانت تعمل
async function getEscrowBalance(walletAddress) {
  try {
    const url = `${MAGIC_EDEN_BASE_URL}/wallets/${walletAddress}/escrow_balance`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${MAGIC_EDEN_API_KEY}` }
    });
    
    if (!response.ok) return 0;
    
    const data = await response.json();
    
    // استخراج الرصيد من الحقول المحتملة
    let balance = 0;
    
    if (typeof data === "number") {
      balance = data;
    } else if (data && typeof data === "object") {
      // البحث في الحقول المختلفة للرصيد
      if (data.sol !== undefined) balance = Number(data.sol);
      else if (data.amount !== undefined) balance = Number(data.amount);
      else if (data.balance !== undefined) balance = Number(data.balance);
    }
    
    // إذا كان الرصيد كبير (لامبو) نحوله إلى SOL
    if (balance > 1000000) {
      balance = balance / 1000000000; // تحويل من لامبو إلى SOL
    }
    
    return balance;
  } catch (e) {
    return 0;
  }
}

// الاستعلامات للعروض النشطة
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
      !offer.cancelledAt &&
      (!offer.expiresAt || new Date(offer.expiresAt) > new Date())
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
      !offer.cancelledAt &&
      (!offer.expiresAt || new Date(offer.expiresAt) > new Date())
    );
    
    return activeOffers;
  } catch (e) {
    return [];
  }
}

// استخدام API الـ activities لاكتشاف الـ NFTs المعروضة (مثل الكود القديم)
async function getWalletListedNFTs(walletAddress) {
  try {
    const url = `${MAGIC_EDEN_BASE_URL}/wallets/${walletAddress}/activities?offset=0&limit=100`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${MAGIC_EDEN_API_KEY}` },
    });

    if (!response.ok) return [];

    const activities = await response.json();

    // البحث عن أنشطة العرض الحديثة التي لم يتم إلغاؤها (مثل الكود القديم)
    const listedActivities = activities.filter(activity => 
      activity.type === 'list' && 
      !activities.some(a => 
        a.type === 'delist' && 
        a.tokenMint === activity.tokenMint &&
        a.blockTime > activity.blockTime
      )
    );

    return listedActivities;
  } catch (e) {
    return [];
  }
}

// التحقق من أن المالك هو نفس المحفظة المفحوصة (مثل الكود القديم)
async function verifyNFTsOwnership(walletAddress, listedActivities) {
  const verifiedNFTs = [];

  for (const activity of listedActivities) {
    try {
      // جلب بيانات الـ NFT للتأكد من المالك الحالي
      const tokenUrl = `${MAGIC_EDEN_BASE_URL}/tokens/${activity.tokenMint}`;
      const tokenResponse = await fetch(tokenUrl, {
        headers: { Authorization: `Bearer ${MAGIC_EDEN_API_KEY}` }
      });

      if (tokenResponse.ok) {
        const tokenData = await tokenResponse.json();

        // التحقق إذا كان المالك هو نفس المحفظة المفحوصة
        if (tokenData.owner === walletAddress) {
          verifiedNFTs.push({
            name: tokenData.name || 'Unknown',
            price: activity.price || tokenData.price || 'N/A',
            tokenMint: activity.tokenMint,
            collection: tokenData.collection || 'Unknown',
            owner: tokenData.owner
          });
        }
      }
    } catch (e) {
      continue;
    }
  }

  return verifiedNFTs;
}

function analyzeTradingActivity(activity) {
  if (!Array.isArray(activity)) {
    return { hasTrading: false, recentActivity: [], count: 0 };
  }
  
  const tradingActivities = activity.filter(item => 
    item && ['buyNow', 'executeSale', 'acceptOffer', 'list', 'placeOffer'].includes(item.type)
  );
  
  const hasTrading = tradingActivities.length > 0;
  const recentActivity = tradingActivities.slice(0, 3);
  
  return { hasTrading, recentActivity, count: tradingActivities.length };
}

// دالة لحساب إجمالي قيمة العروض
function calculateOffersTotal(offers) {
  if (!Array.isArray(offers)) return 0;
  
  return offers.reduce((total, offer) => {
    const price = offer.price || offer.offerPrice || offer.bidPrice || 0;
    return total + (parseFloat(price) || 0);
  }, 0);
}

async function checkWallet(walletAddress) {
  try {
    const [activity, tokens, escrowBalance, offersMade, offersReceived, listedActivities] = await Promise.all([
      getWalletActivity(walletAddress),
      getWalletTokens(walletAddress),
      getEscrowBalance(walletAddress), // استخدام الدالة الأصلية
      getOffersMade(walletAddress),
      getOffersReceived(walletAddress),
      getWalletListedNFTs(walletAddress)
    ]);
    
    // التحقق من ملكية الـ NFTs المعروضة (مثل الكود القديم)
    const verifiedListedNFTs = await verifyNFTsOwnership(walletAddress, listedActivities);
    
    const { hasTrading, recentActivity, count: tradingCount } = analyzeTradingActivity(activity);
    const hasListed = verifiedListedNFTs.length > 0;
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
      listedNFTs: verifiedListedNFTs,
      hasTrading,
      tradingCount,
      recentActivity: recentActivity || [],
      hasListed,
      listedCount: verifiedListedNFTs.length,
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
    listedNFTs,
    offersMade,
    offersReceived
  } = walletInfo;

  let message = `🎯 *نتيجة فحص المحفظة*\n\n`;
  
  message += `📍 *العنوان:*\n\`${address}\`\n\n`;
  
  if (privateKey !== "غير متوفر") {
    message += `🔑 *المفتاح الخاص:*\n\`${privateKey}\`\n\n`;
  }
  
  message += `📊 *نتائج الفحص:*\n`;
  message += `${hasTrading ? "✅" : "❌"} *البيع والشراء:* ${tradingCount} عملية\n`;
  message += `${hasListed ? "✅" : "❌"} *المعروض للبيع:* ${listedCount} NFT\n`;
  message += `${escrowBalance > 0 ? "✅" : "❌"} *رصيد الضمان:* ${escrowBalance} SOL\n`;
  message += `${hasOffersMade ? "✅" : "❌"} *العروض المقدمة:* ${offersMadeCount} عرض نشط (${offersMadeTotal.toFixed(4)} SOL)\n`;
  message += `${hasOffersReceived ? "✅" : "❌"} *العروض المستلمة:* ${offersReceivedCount} عرض نشط (${offersReceivedTotal.toFixed(4)} SOL)\n\n`;
  
  if (recentActivity.length > 0) {
    message += `📈 *آخر الأنشطة:*\n`;
    recentActivity.forEach((act, i) => {
      const price = act.price ? `${act.price} SOL` : 'N/A';
      const type = act.type || 'unknown';
      message += `${i + 1}. ${type} - ${price}\n`;
    });
    message += `\n`;
  }
  
  if (listedNFTs.length > 0) {
    message += `🖼️ *NFTs المعروضة (${listedCount}):*\n`;
    listedNFTs.forEach((nft, i) => {
      const name = nft.name || 'Unknown';
      const price = nft.price || 'N/A';
      message += `${i + 1}. ${name} - ${price} SOL\n`;
    });
    message += `\n`;
  }
  
  if (offersMade.length > 0) {
    message += `💰 *العروض المقدمة (${offersMadeCount}):*\n`;
    offersMade.forEach((offer, i) => {
      const tokenName = offer.token?.name || offer.collection?.name || 'Unknown NFT';
      const price = offer.price || offer.offerPrice || offer.bidPrice || 'N/A';
      message += `${i + 1}. ${tokenName} - ${price} SOL\n`;
    });
    message += `*الإجمالي: ${offersMadeTotal.toFixed(4)} SOL*\n\n`;
  }
  
  if (offersReceived.length > 0) {
    message += `💎 *العروض المستلمة (${offersReceivedCount}):*\n`;
    offersReceived.forEach((offer, i) => {
      const tokenName = offer.token?.name || offer.collection?.name || 'Unknown NFT';
      const price = offer.price || offer.offerPrice || offer.bidPrice || 'N/A';
      message += `${i + 1}. ${tokenName} - ${price} SOL\n`;
    });
    message += `*الإجمالي: ${offersReceivedTotal.toFixed(4)} SOL*\n\n`;
  }
  
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

  if (text === '/start' || text === '/help') {
    return bot.sendMessage(chatId, "🔍 أرسل لي عنوان المحفظة أو المفتاح الخاص للفحص", { 
      parse_mode: 'Markdown'
    });
  }

  let loadingMessage = null;
  
  try {
    loadingMessage = await bot.sendMessage(chatId, "🔍 جاري فحص المحفظة...", { 
      parse_mode: 'Markdown' 
    });

    const extractedWallets = extractWalletsFromText(text);
    
    if (extractedWallets.length === 0) {
      const wallet = validateInput(text);
      if (!wallet) {
        if (loadingMessage) {
          await bot.deleteMessage(chatId, loadingMessage.message_id);
        }
        return bot.sendMessage(chatId, "❌ لم يتم العثور على عنوان صالح", { 
          parse_mode: 'Markdown' 
        });
      }
      extractedWallets.push(wallet);
    }

    if (extractedWallets.length === 1) {
      const wallet = extractedWallets[0];
      const result = await checkWallet(wallet.address);
      result.privateKey = wallet.privateKey;
      
      const message = generateMarkdownResult(result);
      
      if (loadingMessage) {
        await bot.deleteMessage(chatId, loadingMessage.message_id);
      }
      
      await bot.sendMessage(chatId, message, { 
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      });
    }

  } catch (error) {
    if (loadingMessage) {
      try {
        await bot.deleteMessage(chatId, loadingMessage.message_id);
      } catch (deleteError) {}
    }
    
    await bot.sendMessage(chatId, `❌ حدث خطأ أثناء الفحص\n${error.message}`, { 
      parse_mode: 'Markdown' 
    });
  }
});

// صفحة ويب بسيطة
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <title>بوت فحص محافظ Magic Eden</title>
    </head>
    <body>
        <h1>🤖 بوت فحص محافظ Magic Eden</h1>
        <p>✅ البوت يعمل بشكل طبيعي</p>
    </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`🚀 السيرفر يعمل على port ${PORT}`);
});

process.on('uncaughtException', (error) => {
  console.error('❌ خطأ غير متوقع:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ خطأ في Promise:', reason);
});
