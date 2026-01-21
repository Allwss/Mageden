import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import fs from "fs";
import express from "express";
import TelegramBot from "node-telegram-bot-api";

const app = express();
const PORT = process.env.PORT || 3000;

// RPC (Alchemy)
const ALCHEMY_KEYS = [
  process.env.RPC_URL,
  process.env.RPC_URL2,
  process.env.RPC_URL3
].filter(Boolean);

function getConnection() {
  const key = ALCHEMY_KEYS[0] || "A9xPBcSGQkSIa9owFAab88-KbrZWw7iL"; // Fallback to hardcoded if env not set
  const RPC_URL = `https://solana-mainnet.g.alchemy.com/v2/${key}`;
  return new Connection(RPC_URL, "confirmed");
}

const connection = getConnection();

// 🔴 Program ID الخاص بـ pump.fun
const PUMP_PROGRAM_ID = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);

// إعدادات التلجرام
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MAGIC_EDEN_API_KEY = process.env.MAGIC_EDEN_API_KEY;

if (!TELEGRAM_BOT_TOKEN || !MAGIC_EDEN_API_KEY) {
  console.error("❌ يرجى تعيين TELEGRAM_BOT_TOKEN و MAGIC_EDEN_API_KEY في متغيرات البيئة");
  process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const MAGIC_EDEN_BASE_URL = "https://api-mainnet.magiceden.dev/v2";

// دالة لحساب PDA الخاص بالمكافآت
function getCreatorVaultPDA(creator) {
  const [pda, _bump] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("creator-vault"),
      creator.toBuffer()
    ],
    PUMP_PROGRAM_ID
  );
  return pda;
}

// تخزين مؤقت للطلبات
const userRequests = new Map();

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// دالة لاستخراج العناوين والمفاتيح من النص - محسنة
function extractWalletsFromText(text) {
  const lines = text.split('\n');
  const wallets = [];
  const processedAddresses = new Set(); // لمنع التكرار
  
  lines.forEach(line => {
    const trimmedLine = line.trim();
    if (!trimmedLine) return;
    
    // البحث عن عناوين Solana (32-44 حرف)
    const solanaAddressRegex = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
    const addresses = trimmedLine.match(solanaAddressRegex);
    
    if (addresses) {
      addresses.forEach(address => {
        const cleanAddress = address.trim();
        if (cleanAddress.length >= 32 && cleanAddress.length <= 44 && !processedAddresses.has(cleanAddress)) {
          wallets.push({
            address: cleanAddress,
            privateKey: "غير متوفر",
            hasPrivateKey: false,
            source: 'address'
          });
          processedAddresses.add(cleanAddress);
        }
      });
    }
    
    // البحث عن مفاتيح خاصة base58
    try {
      const secretKey = bs58.decode(trimmedLine);
      if (secretKey.length === 64) {
        const keypair = Keypair.fromSecretKey(secretKey);
        const address = keypair.publicKey.toBase58();
        
        if (!processedAddresses.has(address)) {
          wallets.push({
            address: address,
            privateKey: trimmedLine,
            hasPrivateKey: true,
            source: 'privateKey'
          });
          processedAddresses.add(address);
        }
      }
    } catch (error) {
      // ليس مفتاح خاص صالح
    }
  });
  
  return wallets;
}

// باقي الدوال تبقى كما هي (getWalletActivity, getWalletTokens, etc.)
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
    let balance = 0;
    
    if (typeof data === "number") {
      balance = data;
    } else if (data && typeof data === "object") {
      if (data.sol !== undefined) balance = Number(data.sol);
      else if (data.amount !== undefined) balance = Number(data.amount);
      else if (data.balance !== undefined) balance = Number(data.balance);
    }
    
    if (balance > 1000000) {
      balance = balance / 1000000000;
    }
    
    return balance;
  } catch (e) {
    return 0;
  }
}

async function getOffersMade(walletAddress) {
  try {
    const url = `${MAGIC_EDEN_BASE_URL}/wallets/${walletAddress}/offers_made`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${MAGIC_EDEN_API_KEY}` },
    });
    
    if (!response.ok) return [];
    
    const allOffers = await response.json();
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

async function getWalletListedNFTs(walletAddress) {
  try {
    const url = `${MAGIC_EDEN_BASE_URL}/wallets/${walletAddress}/activities?offset=0&limit=100`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${MAGIC_EDEN_API_KEY}` },
    });

    if (!response.ok) return [];

    const activities = await response.json();
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

async function verifyNFTsOwnership(walletAddress, listedActivities) {
  const verifiedNFTs = [];

  for (const activity of listedActivities) {
    try {
      const tokenUrl = `${MAGIC_EDEN_BASE_URL}/tokens/${activity.tokenMint}`;
      const tokenResponse = await fetch(tokenUrl, {
        headers: { Authorization: `Bearer ${MAGIC_EDEN_API_KEY}` }
      });

      if (tokenResponse.ok) {
        const tokenData = await tokenResponse.json();
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

function calculateOffersTotal(offers) {
  if (!Array.isArray(offers)) return 0;
  
  return offers.reduce((total, offer) => {
    const price = offer.price || offer.offerPrice || offer.bidPrice || 0;
    return total + (parseFloat(price) || 0);
  }, 0);
}

async function checkWallet(walletAddress) {
  try {
    const creatorWallet = new PublicKey(walletAddress);
    const pumpPDA = getCreatorVaultPDA(creatorWallet);
    
    const [activity, tokens, escrowBalance, offersMade, offersReceived, listedActivities, pumpBalance] = await Promise.all([
      getWalletActivity(walletAddress),
      getWalletTokens(walletAddress),
      getEscrowBalance(walletAddress),
      getOffersMade(walletAddress),
      getOffersReceived(walletAddress),
      getWalletListedNFTs(walletAddress),
      connection.getBalance(pumpPDA).catch(() => 0)
    ]);
    
    const verifiedListedNFTs = await verifyNFTsOwnership(walletAddress, listedActivities);
    
    const { hasTrading, recentActivity, count: tradingCount } = analyzeTradingActivity(activity);
    const hasListed = verifiedListedNFTs.length > 0;
    const hasOffersMade = Array.isArray(offersMade) && offersMade.length > 0;
    const hasOffersReceived = Array.isArray(offersReceived) && offersReceived.length > 0;

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
      offersReceivedTotal: offersReceivedTotal,
      pumpPDA: pumpPDA.toBase58(),
      pumpBalance: pumpBalance / 1e9
    };
  } catch (e) {
    throw new Error(`فشل في فحص المحفظة: ${e.message}`);
  }
}

// دالة مختصرة للنتائج عند وجود عدة محافظ
function generateShortResult(walletInfo, index, total) {
  const {
    address,
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
    offersReceivedTotal
  } = walletInfo;

  let message = `📋 *المحفظة ${index + 1} من ${total}*\n`;
  message += `📍 \`${address.substring(0, 8)}...${address.substring(address.length - 8)}\`\n`;
  message += `🔄 ${hasTrading ? "✅" : "❌"} ${tradingCount} عملية\n`;
  message += `🏪 ${hasListed ? "✅" : "❌"} ${listedCount} معروض\n`;
  message += `💰 ${escrowBalance > 0 ? "✅" : "❌"} ${escrowBalance.toFixed(4)} SOL\n`;
  message += `📤 ${hasOffersMade ? "✅" : "❌"} ${offersMadeCount} عرض (${offersMadeTotal.toFixed(4)} SOL)\n`;
  message += `📥 ${hasOffersReceived ? "✅" : "❌"} ${offersReceivedCount} عرض (${offersReceivedTotal.toFixed(4)} SOL)\n\n`;

  return message;
}

// دالة كاملة للنتائج لمحفظة واحدة
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

function generatePumpResult(walletInfo) {
  const { address, pumpPDA, pumpBalance } = walletInfo;
  let message = `💊 *نتائج فحص Pump.fun*\n\n`;
  message += `📍 *المحفظة:* \`${address}\`\n`;
  message += `🏦 *PDA للمكافآت:* \`${pumpPDA}\`\n`;
  message += `💰 *الرصيد:* ${pumpBalance.toFixed(4)} SOL\n\n`;
  message += `🔗 [عرض على Solscan](https://solscan.io/account/${pumpPDA})`;
  return message;
}

// تقسيم الرسائل الطويلة
async function sendLongMessage(chatId, text, options = {}) {
  const maxLength = 4096;
  if (text.length <= maxLength) {
    return bot.sendMessage(chatId, text, options);
  }

  const parts = [];
  let currentPart = '';
  const lines = text.split('\n');

  for (const line of lines) {
    if (currentPart.length + line.length + 1 > maxLength) {
      parts.push(currentPart);
      currentPart = line;
    } else {
      currentPart += (currentPart ? '\n' : '') + line;
    }
  }

  if (currentPart) {
    parts.push(currentPart);
  }

  for (const part of parts) {
    await bot.sendMessage(chatId, part, options);
    await sleep(500); // تأخير بين الرسائل
  }
}

// معالجة رسائل التلجرام - محسنة
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const messageId = msg.message_id;

  if (!text) return;

  if (text === '/start' || text === '/help') {
    return bot.sendMessage(chatId, 
      `🔍 *بوت فحص محافظ Magic Eden*\n\n` +
      `*طريقة الاستخدام:*\n` +
      `• أرسل عنوان محفظة واحد\n` +
      `• أرسل مفتاح خاص واحد\n` +
      `• أرسل قائمة بعناوين متعددة\n` +
      `• أرسل قائمة بمفاتيح متعددة\n\n` +
      `*ملاحظات:*\n` +
      `• يمكنك إرسال حتى 20 محفظة في مرة واحدة\n` +
      `• النتائج تظهر بشكل مختصر للمحافظ المتعددة\n` +
      `• استخدم /cancel لإلغاء العملية الجارية`,
      { parse_mode: 'Markdown' }
    );
  }

  if (text === '/cancel') {
    userRequests.delete(chatId);
    return bot.sendMessage(chatId, "✅ تم إلغاء أي عملية جارية");
  }

  // منع الطلبات المكررة
  if (userRequests.has(chatId)) {
    return bot.sendMessage(chatId, "⏳ يوجد عملية فحص جارية بالفعل، انتظر حتى تنتهي");
  }

  userRequests.set(chatId, true);

  let loadingMessage = null;
  
  try {
    loadingMessage = await bot.sendMessage(chatId, "🔍 جاري فحص المحفظة/المحافظ...", { 
      parse_mode: 'Markdown' 
    });

    const extractedWallets = extractWalletsFromText(text);
    
    if (extractedWallets.length === 0) {
      throw new Error("❌ لم يتم العثور على عناوين أو مفاتيح صالحة في الرسالة");
    }

    if (extractedWallets.length > 20) {
      throw new Error("❌ الحد الأقصى للمحافظ في المرة الواحدة هو 20 محفظة");
    }

    // إرسال رسالة بدء الفحص
    await bot.editMessageText(
      `🔍 جاري فحص ${extractedWallets.length} محفظة...\n⏳ قد يستغرق هذا بضع دقائق`,
      {
        chat_id: chatId,
        message_id: loadingMessage.message_id,
        parse_mode: 'Markdown'
      }
    );

    const results = [];
    let processed = 0;

    // فحص جميع المحافظ مع تحديث التقدم
    for (const wallet of extractedWallets) {
      try {
        const result = await checkWallet(wallet.address);
        result.privateKey = wallet.privateKey;
        results.push(result);
        processed++;
        
        // تحديث رسالة التقدم كل 5 محافظ
        if (processed % 5 === 0 || processed === extractedWallets.length) {
          await bot.editMessageText(
            `🔍 جاري فحص المحافظ...\n✅ تم معالجة ${processed} من ${extractedWallets.length}`,
            {
              chat_id: chatId,
              message_id: loadingMessage.message_id,
              parse_mode: 'Markdown'
            }
          );
        }
        
        await sleep(1000); // تأخير بين الطلبات لتجنب rate limiting
      } catch (error) {
        console.error(`فشل في فحص المحفظة ${wallet.address}:`, error);
        results.push({
          address: wallet.address,
          error: error.message,
          privateKey: wallet.privateKey
        });
      }
    }

    // حذف رسالة التحميل
    if (loadingMessage) {
      await bot.deleteMessage(chatId, loadingMessage.message_id);
    }

    // عرض النتائج
    if (extractedWallets.length === 1) {
      // نتيجة مفصلة لمحفظة واحدة
      const result = results[0];
      if (result.error) {
        await bot.sendMessage(chatId, `❌ فشل في فحص المحفظة:\n${result.error}`, {
          parse_mode: 'Markdown'
        });
      } else {
        const meMessage = generateMarkdownResult(result);
        const pumpMessage = generatePumpResult(result);
        
        await sendLongMessage(chatId, meMessage, {
          parse_mode: 'Markdown',
          disable_web_page_preview: true
        });
        
        await sendLongMessage(chatId, pumpMessage, {
          parse_mode: 'Markdown',
          disable_web_page_preview: true
        });
      }
    } else {
      // نتائج مختصرة لعدة محافظ
      let summaryMessage = `📊 *ملخص فحص ${results.length} محفظة*\n\n`;
      
      let successfulScans = 0;
      let failedScans = 0;
      let totalEscrow = 0;
      let totalOffers = 0;

      results.forEach((result, index) => {
        if (result.error) {
          failedScans++;
          summaryMessage += `❌ *المحفظة ${index + 1}:* فشل في الفحص\n`;
        } else {
          successfulScans++;
          totalEscrow += result.escrowBalance || 0;
          totalOffers += (result.offersMadeTotal || 0) + (result.offersReceivedTotal || 0);
          
          summaryMessage += generateShortResult(result, index, results.length);
          summaryMessage += `💊 رصيد Pump PDA: ${result.pumpBalance.toFixed(4)} SOL\n\n`;
        }
      });

      summaryMessage += `\n📈 *الإحصائيات النهائية:*\n`;
      summaryMessage += `✅ نجح: ${successfulScans} محفظة\n`;
      summaryMessage += `❌ فشل: ${failedScans} محفظة\n`;
      summaryMessage += `💰 إجمالي الرصيد: ${totalEscrow.toFixed(4)} SOL\n`;
      summaryMessage += `💎 إجمالي العروض: ${totalOffers.toFixed(4)} SOL\n\n`;
      summaryMessage += `⏰ *وقت الانتهاء:* ${new Date().toLocaleString('ar-EG')}`;

      await sendLongMessage(chatId, summaryMessage, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      });

      // إرسال خيار للحصول على تفاصيل محفظة معينة
      if (successfulScans > 0) {
        const keyboard = {
          inline_keyboard: [
            results.filter(r => !r.error).map((result, index) => ({
              text: `تفاصيل المحفظة ${index + 1}`,
              callback_data: `detail_${result.address}`
            }))
          ]
        };

        await bot.sendMessage(chatId, "💡 يمكنك الحصول على تفاصيل كاملة لأي محفظة:", {
          reply_markup: keyboard
        });
      }
    }

  } catch (error) {
    if (loadingMessage) {
      try {
        await bot.deleteMessage(chatId, loadingMessage.message_id);
      } catch (deleteError) {}
    }
    
    await bot.sendMessage(chatId, `❌ حدث خطأ:\n${error.message}`, { 
      parse_mode: 'Markdown' 
    });
  } finally {
    userRequests.delete(chatId);
  }
});

// معالجة زر التفاصيل
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;

  if (data.startsWith('detail_')) {
    const address = data.replace('detail_', '');
    
    try {
      const result = await checkWallet(address);
      result.privateKey = "غير متوفر"; // لا نعرض المفتاح الخاص في التفاصيل
      
      const meMessage = generateMarkdownResult(result);
      const pumpMessage = generatePumpResult(result);
      
      await sendLongMessage(chatId, meMessage, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      });

      await sendLongMessage(chatId, pumpMessage, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      });
      
      await bot.answerCallbackQuery(callbackQuery.id);
    } catch (error) {
      await bot.answerCallbackQuery(callbackQuery.id, {
        text: `❌ فشل في جلب التفاصيل: ${error.message}`
      });
    }
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
        <p>🚀 تم إصلاح مشكلة المحافظ المتعددة</p>
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
