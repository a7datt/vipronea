import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import TelegramBot from "node-telegram-bot-api";
import bcrypt from "bcryptjs";
import { createClient } from "@supabase/supabase-js";
import webpush from "web-push";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Supabase Configuration ---
const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.");
}

const supabase = createClient(supabaseUrl, supabaseKey);

// --- Web Push Configuration ---
let vapidKeys = {
  publicKey: process.env.VAPID_PUBLIC_KEY!,
  privateKey: process.env.VAPID_PRIVATE_KEY!,
};

if (vapidKeys.publicKey && vapidKeys.privateKey) {
  try {
    webpush.setVapidDetails(
      "mailto:yallamha86@gmail.com",
      vapidKeys.publicKey,
      vapidKeys.privateKey
    );
  } catch (e) {
    console.error("Failed to set VAPID details. Push notifications may not work.", e);
  }
}

const sendPushNotification = async (userId: string | null, title: string, body: string, url: string = "/") => {
  try {
    let query = supabase.from("push_subscriptions").select("subscription");
    if (userId) query = query.eq("user_id", userId);
    
    const { data: subscriptions } = await query;
    
    if (subscriptions) {
      subscriptions.forEach(sub => {
        try {
          const subscription = JSON.parse(sub.subscription);
          webpush.sendNotification(subscription, JSON.stringify({ title, body, url }))
            .catch(async err => {
              if (err.statusCode === 410 || err.statusCode === 404) {
                await supabase.from("push_subscriptions").delete().eq("subscription", sub.subscription);
              }
            });
        } catch (e) {
          console.error("Push error", e);
        }
      });
    }
  } catch (e) {
    console.error("Push notification error", e);
  }
};

const sendTelegramMessage = async (text: string) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (e) {
    console.error("Telegram error", e);
  }
};

const sendTelegramToUser = async (userId: string, text: string) => {
  const { data: user } = await supabase.from("users").select("telegram_chat_id").eq("id", userId).single();
  if (!user?.telegram_chat_id) return;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: user.telegram_chat_id, text }),
    });
  } catch (e) {
    console.error("Telegram user notify error", e);
  }
};

const userStates = new Map<string, { step: string; data: any }>();

async function startServer() {
  const app = express();
  app.use(express.json());
  const PORT = 3000;

  // --- API Routes ---
  app.use((req, res, next) => {
    if (req.url.startsWith("/api")) {
      console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
    }
    next();
  });

  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.get("/api/settings", async (req, res) => {
    try {
      const { data, error } = await supabase.from("settings").select("*");
      if (error) throw error;
      res.json(data || []);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/categories", async (req, res) => {
    try {
      const { data, error } = await supabase.from("categories").select("*").eq("active", true).order("order_index");
      if (error) throw error;
      res.json(data || []);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/subcategories", async (req, res) => {
    try {
      const { data, error } = await supabase.from("subcategories").select("*").eq("active", true).order("order_index");
      if (error) throw error;
      res.json(data || []);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/sub-sub-categories", async (req, res) => {
    try {
      const { data, error } = await supabase.from("sub_sub_categories").select("*").eq("active", true).order("order_index");
      if (error) throw error;
      res.json(data || []);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/admin/vouchers", async (req, res) => {
    try {
      const { data, error } = await supabase.from("vouchers").select("*").order("created_at", { ascending: false });
      if (error) throw error;
      res.json(data || []);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/admin/vouchers", async (req, res) => {
    try {
      const { code, amount, max_uses } = req.body;
      const { data, error } = await supabase.from("vouchers").insert({ code, amount, max_uses }).select().single();
      if (error) throw error;
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/admin/settings", async (req, res) => {
    try {
      const { settings } = req.body; // Expecting array of {key, value}
      for (const s of settings) {
        await supabase.from("settings").upsert({ key: s.key, value: s.value });
      }
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/admin/offers", async (req, res) => {
    try {
      const { title, description, image_url, active } = req.body;
      const { data, error } = await supabase.from("offers").insert({ title, description, image_url, active }).select().single();
      if (error) throw error;
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/admin/sub-sub-categories", async (req, res) => {
    try {
      const { subcategory_id, name, image_url, order_index, active } = req.body;
      const { data, error } = await supabase.from("sub_sub_categories").insert({ subcategory_id, name, image_url, order_index, active }).select().single();
      if (error) throw error;
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/admin/payment-methods", async (req, res) => {
    try {
      const { name, image_url, wallet_address, instructions, min_amount, active } = req.body;
      const { data, error } = await supabase.from("payment_methods").insert({ name, image_url, wallet_address, instructions, min_amount, active }).select().single();
      if (error) throw error;
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/admin/banners", async (req, res) => {
    try {
      const { image_url, order_index } = req.body;
      const { data, error } = await supabase.from("banners").insert({ image_url, order_index }).select().single();
      if (error) throw error;
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/admin/manual-topup", async (req, res) => {
    try {
      const { userId, amount, note } = req.body;
      await supabase.rpc('increment_balance', { user_id_param: userId, amount_param: amount });
      await supabase.from("transactions").insert({
        user_id: userId,
        amount,
        note: note || "شحن يدوي من الإدارة",
        status: 'approved'
      });
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/referrals/stats/:userId", async (req, res) => {
    try {
      const { userId } = req.params;
      const { data: referrals, error } = await supabase.from("users").select("id, name, created_at").eq("referred_by_id", userId);
      if (error) throw error;
      res.json({
        count: referrals?.length || 0,
        referrals: referrals || []
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/user/:userId/avatar", async (req, res) => {
    try {
      const { avatarUrl } = req.body;
      await supabase.from("users").update({ avatar_url: avatarUrl }).eq("id", req.params.userId);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/user/update", async (req, res) => {
    try {
      const { userId, name, phone } = req.body;
      await supabase.from("users").update({ name, phone }).eq("id", userId);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/rewards/claim", async (req, res) => {
    try {
      const { userId, rewardIndex, rewardAmount } = req.body;
      const { data: stats, error: sErr } = await supabase.from("user_stats").select("*").eq("user_id", userId).single();
      if (sErr) throw sErr;
      
      if (stats.claimed_reward_index >= rewardIndex) {
        return res.status(400).json({ error: "Reward already claimed" });
      }

      await supabase.from("user_stats").update({ claimed_reward_index: rewardIndex }).eq("user_id", userId);
      await supabase.rpc('increment_balance', { user_id_param: userId, amount_param: rewardAmount });
      
      await supabase.from("notifications").insert({
        user_id: userId,
        title: "تم استلام مكافأة",
        message: `لقد حصلت على مكافأة بقيمة ${rewardAmount}$!`,
        type: 'success'
      });

      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/admin/products/:id/price", async (req, res) => {
    try {
      const { price } = req.body;
      await supabase.from("products").update({ price }).eq("id", req.params.id);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/banners", async (req, res) => {
    try {
      const { data, error } = await supabase.from("banners").select("*").order("order_index");
      if (error) throw error;
      res.json(data || []);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/offers", async (req, res) => {
    try {
      const { data, error } = await supabase.from("offers").select("*").eq("active", true).order("created_at", { ascending: false });
      if (error) throw error;
      res.json(data || []);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/payment-methods", async (req, res) => {
    try {
      const { data, error } = await supabase.from("payment_methods").select("*").eq("active", true);
      if (error) throw error;
      res.json(data || []);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/user/:id", async (req, res) => {
    try {
      const { data: user, error } = await supabase.from("users").select("*").eq("id", req.params.id).single();
      if (error) throw error;
      if (!user) return res.status(404).json({ error: "User not found" });
      const { password_hash, ...userWithoutPass } = user;
      const { data: stats, error: statsErr } = await supabase.from("user_stats").select("*").eq("user_id", user.id).single();
      if (statsErr && statsErr.code !== 'PGRST116') throw statsErr;
      res.json({ ...userWithoutPass, stats });
    } catch (e: any) {
      console.error(`Error fetching user ${req.params.id}:`, e);
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/notifications/:userId", async (req, res) => {
    try {
      const { data, error } = await supabase.from("notifications").select("*").eq("user_id", req.params.userId).order("created_at", { ascending: false });
      if (error) throw error;
      res.json(data || []);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/notifications/mark-read", async (req, res) => {
    try {
      const { notificationId } = req.body;
      const { error } = await supabase.from("notifications").update({ is_read: true }).eq("id", notificationId);
      if (error) throw error;
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/orders/user/:userId", async (req, res) => {
    try {
      const { data, error } = await supabase.from("orders").select("*, order_items(*)").eq("user_id", req.params.userId).order("created_at", { ascending: false });
      if (error) throw error;
      res.json(data || []);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/transactions/user/:userId", async (req, res) => {
    try {
      const { data, error } = await supabase.from("transactions").select("*").eq("user_id", req.params.userId).order("created_at", { ascending: false });
      if (error) throw error;
      res.json(data || []);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/user/unlink-telegram", async (req, res) => {
    try {
      const { userId } = req.body;
      const { error } = await supabase.from("users").update({ telegram_chat_id: null }).eq("id", userId);
      if (error) throw error;
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/user/generate-linking-code", async (req, res) => {
    try {
      const { userId } = req.body;
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      const { error } = await supabase.from("telegram_linking_codes").insert({ user_id: userId, code, expires_at: expiresAt });
      if (error) throw error;
      res.json({ code });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/user/update-theme", async (req, res) => {
    try {
      const { userId, color } = req.body;
      const { error } = await supabase.from("user_stats").update({ custom_theme_color: color }).eq("user_id", userId);
      if (error) throw error;
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/admin/change-password", async (req, res) => {
    try {
      const { newPassword } = req.body;
      const { error } = await supabase.from("settings").upsert({ key: "admin_password", value: newPassword });
      if (error) throw error;
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/user/redeem-voucher", async (req, res) => {
    try {
      const { userId, code } = req.body;
      const { data: voucher, error: vErr } = await supabase.from("vouchers").select("*").eq("code", code).eq("active", true).single();
      if (vErr) throw vErr;
      if (!voucher) return res.status(400).json({ error: "Invalid or inactive voucher" });
      if (voucher.used_count >= voucher.max_uses) return res.status(400).json({ error: "Voucher fully used" });

      const { data: existingUse, error: useErr } = await supabase.from("voucher_uses").select("id").eq("voucher_id", voucher.id).eq("user_id", userId).single();
      if (useErr && useErr.code !== 'PGRST116') throw useErr;
      if (existingUse) return res.status(400).json({ error: "Voucher already used by you" });

      await supabase.from("voucher_uses").insert({ voucher_id: voucher.id, user_id: userId });
      await supabase.from("vouchers").update({ used_count: voucher.used_count + 1 }).eq("id", voucher.id);
      await supabase.rpc('increment_balance', { user_id_param: userId, amount_param: voucher.amount });
      
      res.json({ success: true, amount: voucher.amount });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/push/key", (req, res) => {
    res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
  });

  app.post("/api/push/subscribe", async (req, res) => {
    try {
      const { userId, subscription } = req.body;
      const { error } = await supabase.from("push_subscriptions").upsert({ user_id: userId, subscription: JSON.stringify(subscription) }, { onConflict: 'subscription' });
      if (error) throw error;
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/report-error", (req, res) => {
    console.error("Client Error Report:", req.body);
    res.json({ success: true });
  });

  app.post("/api/transactions/upload", async (req, res) => {
    try {
      const { userId, paymentMethodId, amount, receiptImageUrl, note } = req.body;
      const { data, error } = await supabase.from("transactions").insert({
        user_id: userId,
        payment_method_id: paymentMethodId,
        amount,
        receipt_image_url: receiptImageUrl,
        note,
        status: 'pending'
      }).select().single();
      if (error) throw error;
      sendTelegramMessage(`💰 طلب شحن جديد\nالمبلغ: ${amount}$\nالمستخدم: ${userId}`);
      res.json({ success: true, id: data.id });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/chat/messages/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const isGuest = req.query.guest === 'true';
      let query = supabase.from("messages").select("*");
      if (isGuest) {
        query = query.eq("guest_id", id);
      } else {
        query = query.eq("user_id", id);
      }
      const { data, error } = await query.order("created_at", { ascending: true });
      if (error) throw error;
      res.json(data || []);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/chat/mark-read", async (req, res) => {
    try {
      const { user_id, guest_id } = req.body;
      let query = supabase.from("messages").update({ is_read: true }).eq("sender_role", "admin");
      if (user_id) query = query.eq("user_id", user_id);
      else if (guest_id) query = query.eq("guest_id", guest_id);
      const { error } = await query;
      if (error) throw error;
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // --- Admin API Routes ---
  app.get("/api/admin/chat/list", async (req, res) => {
    try {
      const { data, error } = await supabase.from("messages").select("*, users(name, is_vip, personal_number)").order("created_at", { ascending: false });
      if (error) throw error;
      
      // Group by user/guest
      const groups: any = {};
      data?.forEach(msg => {
        const key = msg.user_id ? `u_${msg.user_id}` : `g_${msg.guest_id}`;
        if (!groups[key]) {
          groups[key] = {
            id: msg.user_id || msg.guest_id,
            isGuest: !msg.user_id,
            name: msg.users?.name || (msg.user_id ? "User" : "Guest"),
            is_vip: msg.users?.is_vip || false,
            personal_number: msg.users?.personal_number || (msg.guest_id ? msg.guest_id.split('_')[1] : "N/A"),
            lastMessage: msg.content,
            lastTime: msg.created_at,
            unreadCount: msg.sender_role === 'user' && !msg.is_read ? 1 : 0
          };
        } else if (msg.sender_role === 'user' && !msg.is_read) {
          groups[key].unreadCount++;
        }
      });
      res.json(Object.values(groups));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/admin/users", async (req, res) => {
    try {
      const { data, error } = await supabase.from("users").select("*, user_stats(*)").order("created_at", { ascending: false });
      if (error) throw error;
      res.json(data || []);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/admin/orders", async (req, res) => {
    try {
      const { data, error } = await supabase.from("orders").select("*, users(name), order_items(*, products(name))").order("created_at", { ascending: false });
      if (error) throw error;
      res.json(data || []);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/admin/transactions", async (req, res) => {
    try {
      const { data, error } = await supabase.from("transactions").select("*, users(name), payment_methods(name)").order("created_at", { ascending: false });
      if (error) throw error;
      res.json(data || []);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/admin/transactions/:id/approve", async (req, res) => {
    try {
      const { id } = req.params;
      const { data: tx, error: txErr } = await supabase.from("transactions").select("*").eq("id", id).single();
      if (txErr) throw txErr;
      if (tx.status !== 'pending') return res.status(400).json({ error: "Transaction already processed" });

      await supabase.from("transactions").update({ status: 'approved' }).eq("id", id);
      await supabase.rpc('increment_balance', { user_id_param: tx.user_id, amount_param: tx.amount });
      await supabase.from("user_stats").update({ total_recharge_sum: tx.amount }).eq("user_id", tx.user_id); // This should be an increment but for now...
      
      await supabase.from("notifications").insert({
        user_id: tx.user_id,
        title: "تم قبول الشحن",
        message: `تمت إضافة ${tx.amount}$ إلى رصيدك بنجاح.`,
        type: 'success'
      });

      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/admin/transactions/:id/reject", async (req, res) => {
    try {
      const { id } = req.params;
      await supabase.from("transactions").update({ status: 'rejected' }).eq("id", id);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/admin/orders/:id/status", async (req, res) => {
    try {
      const { id } = req.params;
      const { status, response } = req.body;
      const { data: order, error: oErr } = await supabase.from("orders").update({ status, admin_response: response }).eq("id", id).select().single();
      if (oErr) throw oErr;

      await supabase.from("notifications").insert({
        user_id: order.user_id,
        title: `تحديث حالة الطلب #${id}`,
        message: `حالة طلبك الآن: ${status}. ${response || ""}`,
        type: status === 'completed' ? 'success' : 'info'
      });

      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/admin/users/:id/vip", async (req, res) => {
    try {
      const { isVip } = req.body;
      await supabase.from("users").update({ is_vip: isVip }).eq("id", req.params.id);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/admin/users/:id/balance", async (req, res) => {
    try {
      const { amount } = req.body;
      await supabase.from("users").update({ balance: amount }).eq("id", req.params.id);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/admin/users/:id/block", async (req, res) => {
    try {
      const { blockedUntil } = req.body;
      await supabase.from("users").update({ blocked_until: blockedUntil, is_banned: !!blockedUntil }).eq("id", req.params.id);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/admin/users/:id", async (req, res) => {
    try {
      await supabase.from("users").delete().eq("id", req.params.id);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/admin/categories", async (req, res) => {
    try {
      const { name, image_url, order_index, active } = req.body;
      const { data, error } = await supabase.from("categories").insert({ name, image_url, order_index, active }).select().single();
      if (error) throw error;
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/admin/subcategories", async (req, res) => {
    try {
      const { category_id, name, image_url, order_index, active } = req.body;
      const { data, error } = await supabase.from("subcategories").insert({ category_id, name, image_url, order_index, active }).select().single();
      if (error) throw error;
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/admin/products", async (req, res) => {
    try {
      const { subcategory_id, sub_sub_category_id, name, price, description, image_url, store_type, requires_input, min_quantity, available } = req.body;
      const { data, error } = await supabase.from("products").insert({
        subcategory_id, sub_sub_category_id, name, price, description, image_url, store_type, requires_input, min_quantity, available
      }).select().single();
      if (error) throw error;
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/admin/:type/:id", async (req, res) => {
    try {
      const { type, id } = req.params;
      const tableMap: any = {
        categories: "categories",
        subcategories: "subcategories",
        products: "products",
        banners: "banners",
        offers: "offers",
        vouchers: "vouchers",
        'payment-methods': "payment_methods",
        'sub-sub-categories': "sub_sub_categories"
      };
      const table = tableMap[type];
      if (!table) return res.status(400).json({ error: "Invalid type" });
      const { error } = await supabase.from(table).delete().eq("id", id);
      if (error) throw error;
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Auth
  app.post("/api/auth/register", async (req, res) => {
    const { name, email, password, phone, referralCode } = req.body;
    try {
      let personalNumber = "";
      while (true) {
        personalNumber = Math.floor(1000000 + Math.random() * 9000000).toString();
        const { data: existing } = await supabase.from("users").select("id").eq("personal_number", personalNumber).single();
        if (!existing) break;
      }

      let referredById = null;
      if (referralCode) {
        const { data: referrer } = await supabase.from("users").select("id").eq("personal_number", referralCode).single();
        if (referrer) {
          referredById = referrer.id;
          await supabase.rpc('increment_referral_count', { user_id_param: referrer.id });
        }
      }

      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(password, salt);

      const { data: user, error } = await supabase.from("users").insert({
        name, email, password_hash: hashedPassword, phone, personal_number: personalNumber, referred_by_id: referredById
      }).select().single();

      if (error) throw error;

      await supabase.from("user_stats").insert({ user_id: user.id });
      const { data: stats } = await supabase.from("user_stats").select("*").eq("user_id", user.id).single();

      sendTelegramMessage(`👤 مستخدم جديد\nالاسم: ${name}\nالهاتف: ${phone}\nالرقم الشخصي: ${personalNumber}`);
      res.json({ ...user, stats });
    } catch (e: any) {
      res.status(400).json({ error: e.message || "Registration failed" });
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    const { email, password } = req.body;
    const { data: user } = await supabase.from("users").select("*").eq("email", email).single();
    
    if (user) {
      if (user.is_banned) return res.status(403).json({ error: "Your account has been banned." });
      const isMatch = await bcrypt.compare(password, user.password_hash);
      if (isMatch) {
        const today = new Date().toISOString().split('T')[0];
        await supabase.from("user_stats").update({ last_login_date: today }).eq("user_id", user.id);
        
        const { password_hash, ...userWithoutPass } = user;
        const { data: stats } = await supabase.from("user_stats").select("*").eq("user_id", user.id).single();
        res.json({ ...userWithoutPass, stats });
        return;
      }
    }
    res.status(401).json({ error: "Invalid credentials" });
  });

  // Orders
  app.post("/api/orders", async (req, res) => {
    try {
      const { userId, productId, quantity, extraData } = req.body;
      const { data: user, error: uErr } = await supabase.from("users").select("*").eq("id", userId).single();
      if (uErr) throw uErr;
      const { data: product, error: pErr } = await supabase.from("products").select("*").eq("id", productId).single();
      if (pErr) throw pErr;

      if (!user || !product) return res.status(404).json({ error: "Not found" });

      let total = product.price * quantity;
      const { data: stats } = await supabase.from("user_stats").select("*").eq("user_id", userId).single();
      
      let discountPercent = user.is_vip ? 5 : 0;
      if (stats) {
        if (stats.discount_expires_at && new Date(stats.discount_expires_at) > new Date()) {
          discountPercent = Math.max(discountPercent, stats.active_discount || 0);
        }
        if (stats.one_product_discount_percent > 0) {
          discountPercent = Math.max(discountPercent, stats.one_product_discount_percent);
          await supabase.from("user_stats").update({ one_product_discount_percent: 0 }).eq("user_id", userId);
        }
      }

      if (discountPercent > 0) total *= (1 - discountPercent / 100);
      if (user.balance < total) return res.status(400).json({ error: "Insufficient balance" });

      const { data: order, error: orderErr } = await supabase.from("orders").insert({
        user_id: userId, total_amount: total, meta: JSON.stringify(extraData)
      }).select().single();

      if (orderErr) throw orderErr;

      await supabase.from("order_items").insert({
        order_id: order.id, product_id: productId, price_at_purchase: product.price, quantity, extra_data: JSON.stringify(extraData)
      });

      await supabase.from("users").update({ balance: user.balance - total }).eq("id", userId);

      // Referral Commission
      if (user.referred_by_id) {
        const commission = total * 0.05;
        await supabase.rpc('increment_balance', { user_id_param: user.referred_by_id, amount_param: commission });
      }

      sendTelegramMessage(`🔔 طلب جديد #ORD${order.id}\nالاسم: ${user.name}\nProduct: ${product.name}\nTotal: ${total}`);
      res.json({ success: true, orderId: order.id });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Chat
  app.post("/api/chat/send", async (req, res) => {
    try {
      const { user_id, guest_id, sender_role, content, image_url, type, rating } = req.body;
      
      // Check limits for users
      if (sender_role === 'user' && user_id) {
        const { data: user } = await supabase.from("users").select("is_vip").eq("id", user_id).single();
        const { data: stats } = await supabase.from("user_stats").select("claimed_reward_index").eq("user_id", user_id).single();
        
        if (!user?.is_vip) {
          let limit = 5; // Default limit
          if (stats) {
            if (stats.claimed_reward_index >= 6) limit = 100; // Goal 7
            else if (stats.claimed_reward_index >= 3) limit = 30; // Goal 4
          }
          
          const today = new Date().toISOString().split('T')[0];
          const { data: countData } = await supabase
            .from("daily_message_counts")
            .select("count")
            .eq("user_id", user_id)
            .eq("date", today)
            .single();
            
          const currentCount = countData?.count || 0;
          if (currentCount >= limit) {
            return res.status(403).json({ error: `لقد وصلت للحد اليومي (${limit} رسالة).` });
          }
          
          // Increment count
          if (countData) {
            await supabase.from("daily_message_counts").update({ count: currentCount + 1 }).eq("user_id", user_id).eq("date", today);
          } else {
            await supabase.from("daily_message_counts").insert({ user_id, date: today, count: 1 });
          }
        }
      }

      const { data: msg, error } = await supabase.from("messages").insert({
        user_id, guest_id, sender_role, content, image_url, type: type || 'text', rating
      }).select().single();

      if (error) throw error;

      if (sender_role === 'user') {
        sendTelegramMessage(`💬 رسالة جديدة:\n${content || "[صورة]"}`);
        
        // Check for auto-replies
        if (content) {
          const { data: autoReply } = await supabase
            .from("auto_replies")
            .select("reply_text")
            .ilike("trigger_text", content.trim())
            .limit(1)
            .single();
            
          if (autoReply) {
            await supabase.from("messages").insert({
              user_id,
              guest_id,
              sender_role: 'admin',
              content: autoReply.reply_text,
              type: 'bot_reply'
            });
          }
        }
      } else if (user_id) {
        sendPushNotification(user_id, "رد من الدعم", "لقد تلقيت رداً جديداً.");
      }

      res.json({ success: true, id: msg.id });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/admin/auto-replies", async (req, res) => {
    try {
      const { data, error } = await supabase.from("auto_replies").select("*").order("created_at", { ascending: false });
      if (error) throw error;
      res.json(data || []);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/admin/auto-replies", async (req, res) => {
    try {
      const { trigger_text, reply_text } = req.body;
      const { data, error } = await supabase.from("auto_replies").insert({ trigger_text, reply_text }).select().single();
      if (error) throw error;
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/admin/auto-replies/:id", async (req, res) => {
    try {
      await supabase.from("auto_replies").delete().eq("id", req.params.id);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Admin
  app.post("/api/admin/login", async (req, res) => {
    try {
      const { password } = req.body;
      const { data: setting, error } = await supabase.from("settings").select("value").eq("key", "admin_password").single();
      if (error && error.code !== 'PGRST116') throw error;
      
      if (password === (setting?.value || "12321")) {
        res.json({ success: true });
      } else {
        res.status(401).json({ error: "Incorrect password" });
      }
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // --- Telegram Bots ---
  const startBots = async () => {
    // Delay bot startup to avoid 409 Conflict during rapid restarts
    await new Promise(resolve => setTimeout(resolve, 3000));

    const adminBotToken = process.env.TELEGRAM_BOT_TOKEN;
    if (adminBotToken) {
      try {
        const adminBot = new TelegramBot(adminBotToken, { polling: true });
        const adminChatId = process.env.TELEGRAM_CHAT_ID;

        adminBot.onText(/\/start/, (msg) => {
          if (msg.chat.id.toString() !== adminChatId) return;
          adminBot.sendMessage(msg.chat.id, "بوت الإدارة جاهز 🛠️");
        });

        adminBot.on("polling_error", (err) => {
          if (err.message.includes("409 Conflict")) {
            console.warn("Admin Bot polling conflict, likely due to restart. Ignoring.");
          } else {
            console.error("Admin Bot polling error:", err);
          }
        });
      } catch (e) {
        console.error("Failed to start Admin Bot:", e);
      }
    }

    const userBotToken = process.env.TELEGRAM_USER_BOT_TOKEN;
    if (userBotToken) {
      try {
        const userBot = new TelegramBot(userBotToken, { polling: true });
        userBot.onText(/\/start/, (msg) => {
          userBot.sendMessage(msg.chat.id, "مرحباً بك في متجر فيبرو! 🛒");
        });
        userBot.on("polling_error", (err) => {
          if (err.message.includes("409 Conflict")) {
            console.warn("User Bot polling conflict, likely due to restart. Ignoring.");
          } else {
            console.error("User Bot polling error:", err);
          }
        });
      } catch (e) {
        console.error("Failed to start User Bot:", e);
      }
    }
  };

  startBots();

  // 404 for API routes
  app.all("/api/*", (req, res) => {
    res.status(404).json({ error: `Route ${req.method} ${req.url} not found` });
  });

  // Vite middleware
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
