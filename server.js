require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// --- تنظیمات تلگرام ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

// --- تنظیمات Supabase (از محیط) ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

if (!BOT_TOKEN || !ADMIN_CHAT_ID || !supabaseUrl || !supabaseKey) {
  console.error('❌ متغیرهای محیطی را کامل تنظیم کنید.');
  process.exit(1);
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- توابع کمکی تلگرام ----------
async function sendTelegramMessage(chatId, text, replyMarkup = null) {
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const payload = { chat_id: chatId, text, parse_mode: 'HTML' };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    const response = await axios.post(url, payload);
    return response.data;
  } catch (error) {
    console.error('خطا در ارسال پیام به تلگرام:', error.response?.data || error.message);
    throw error;
  }
}

// ---------- توابع دیتابیس (Supabase با جدول clinic_requests) ----------
async function getAllRequests() {
  const { data, error } = await supabase
    .from('clinic_requests')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

async function createRequest(requestData) {
  const { data, error } = await supabase
    .from('clinic_requests')
    .insert([requestData])
    .select();
  if (error) throw error;
  return data[0];
}

async function updateRequestStatus(id, status) {
  const { data, error } = await supabase
    .from('clinic_requests')
    .update({ status })
    .eq('id', id)
    .select();
  if (error) throw error;
  return data[0];
}

// ---------- API های سرور ----------
app.get('/api/requests', async (req, res) => {
  try {
    const requests = await getAllRequests();
    res.json(requests);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'خطا در دریافت درخواست‌ها' });
  }
});

app.post('/api/request', async (req, res) => {
  const { name, phone, date, time, note } = req.body;
  if (!name || !phone || !date || !time) {
    return res.status(400).json({ error: 'فیلدهای نام، تلفن، تاریخ و ساعت اجباری هستند.' });
  }

  try {
    const newRequest = await createRequest({
      name,
      phone,
      date,
      time,
      note: note || '',
      status: 'pending'
    });

    // اطلاع‌رسانی به منشی
    const text = `
📋 درخواست نوبت جدید
🆔 شماره: ${newRequest.id}
👤 نام: ${newRequest.name}
📞 تلفن: ${newRequest.phone}
📅 تاریخ: ${newRequest.date}
⏰ ساعت: ${newRequest.time}
📝 توضیحات: ${newRequest.note || 'ندارد'}
    `;
    const replyMarkup = {
      inline_keyboard: [
        [
          { text: '✅ تأیید نوبت', callback_data: `confirm_${newRequest.id}` },
          { text: '❌ رد', callback_data: `reject_${newRequest.id}` }
        ]
      ]
    };
    await sendTelegramMessage(ADMIN_CHAT_ID, text, replyMarkup);

    res.status(201).json({ message: 'درخواست شما ثبت شد و به منشی اطلاع داده شد.', request: newRequest });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'خطا در ثبت درخواست' });
  }
});

app.post('/api/confirm', async (req, res) => {
  const { requestId } = req.body;
  try {
    const request = await updateRequestStatus(requestId, 'confirmed');
    if (!request) {
      return res.status(404).json({ error: 'درخواست یافت نشد.' });
    }

    const confirmText = `
✅ نوبت شما برای تاریخ ${request.date} ساعت ${request.time} تأیید شد.
با تشکر از انتخاب کلینیک ما.
    `;
    // فعلاً به منشی اطلاع می‌دهیم (برای ارسال به کاربر نیاز به chat_id داریم)
    await sendTelegramMessage(ADMIN_CHAT_ID, `🔔 پیام تأیید برای کاربر (${request.name} - ${request.phone}):\n${confirmText}`);

    res.json({ message: 'درخواست تأیید شد و پیام تأیید به کاربر ارسال گردید.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'خطا در تأیید درخواست' });
  }
});

// Webhook برای دریافت Callback از تلگرام (اختیاری)
app.post('/webhook', async (req, res) => {
  const { callback_query } = req.body;
  if (callback_query) {
    const data = callback_query.data;
    const chatId = callback_query.from.id;
    if (data.startsWith('confirm_')) {
      const id = parseInt(data.split('_')[1]);
      try {
        await updateRequestStatus(id, 'confirmed');
        await sendTelegramMessage(chatId, `✅ درخواست ${id} تأیید شد.`);
        await sendTelegramMessage(ADMIN_CHAT_ID, `🔔 درخواست ${id} توسط منشی تأیید شد.`);
      } catch (error) {
        await sendTelegramMessage(chatId, '⚠️ خطا در تأیید درخواست.');
      }
    } else if (data.startsWith('reject_')) {
      const id = parseInt(data.split('_')[1]);
      try {
        await updateRequestStatus(id, 'rejected');
        await sendTelegramMessage(chatId, `❌ درخواست ${id} رد شد.`);
      } catch (error) {
        await sendTelegramMessage(chatId, '⚠️ خطا در رد درخواست.');
      }
    }
    res.sendStatus(200);
  } else {
    res.sendStatus(200);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 سرور روی پورت ${PORT} در حال اجراست.`);
  console.log(`📄 فرم نوبت: http://localhost:${PORT}/`);
  console.log(`📊 پنل منشی: http://localhost:${PORT}/admin.html`);
});
