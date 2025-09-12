// server.js
import 'dotenv/config';
import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import { GoogleGenerativeAI } from '@google/generative-ai';

const app = express();
app.use(express.json());
app.use(cors({ origin: true }));

/* -------------------- Config -------------------- */
const { MONGODB_URI, GEMINI_API_KEY, PORT = 5000 } = process.env;
if (!MONGODB_URI) throw new Error('Missing MONGODB_URI');
if (!GEMINI_API_KEY) throw new Error('Missing GEMINI_API_KEY');

await mongoose.connect(MONGODB_URI);
console.log('✅ MongoDB connected');

/* -------------------- Schemas & Models -------------------- */
const MessageSchema = new mongoose.Schema({
  role: { type: String, enum: ['user', 'assistant', 'system'], required: true },
  content: { type: String, required: true },
  timestamp: { type: Date, default: Date.now }
}, { _id: false });

const ConversationSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  messages: { type: [MessageSchema], default: [] },
  doctor: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', default: null },
  pendingDoctor: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', default: null },
  summary: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
});

const DoctorSchema = new mongoose.Schema({
  name: { type: String, required: true },
  specialty: { type: String, required: true },
  hospital: { type: String, default: '' },
  experience: { type: Number, default: 0 },
  available: { type: Boolean, default: true },
});

const TriageSchema = new mongoose.Schema({
  userId: { type: String, required: false },
  symptoms: { type: String, required: true },
  suggestedSpecialty: { type: String, required: true },
  conversationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: false },
  createdAt: { type: Date, default: Date.now },
});

const TempConversationSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  messages: { type: [MessageSchema], default: [] },
  systemInstructions: { type: String, default: "You are a nurse. Your name is Mediverse. You have basic knowledge of medicine, healthcare, and health, always reply user by only vietnamese." },
  createdAt: { type: Date, default: Date.now },
});

const Conversation = mongoose.model('Conversation', ConversationSchema);
const Doctor = mongoose.model('Doctor', DoctorSchema);
const Triage = mongoose.model('Triage', TriageSchema);
const TempConversation = mongoose.model('TempConversation', TempConversationSchema);

// -------------------- Seed Doctor if empty --------------------
async function seedDoctorsIfNeeded() {
  const count = await Doctor.countDocuments();
  if (count === 0) {
    const doctors = [
      { name: "BS. Nguyễn Văn A", specialty: "Tim mạch", hospital: "BV Chợ Rẫy", experience: 12 },
      { name: "BS. Trần Thị B", specialty: "Da liễu", hospital: "BV Da Liễu TP.HCM", experience: 8 },
      { name: "BS. Lê Văn C", specialty: "Tai mũi họng", hospital: "BV Tai Mũi Họng Trung Ương", experience: 10 },
      { name: "BS. Phạm Thị D", specialty: "Tiêu hoá", hospital: "BV Bạch Mai", experience: 15 },
      { name: "BS. Vũ Văn E", specialty: "Hô hấp", hospital: "BV Phổi Trung Ương", experience: 11 },
      { name: "BS. Nguyễn Thị F", specialty: "Cơ xương khớp", hospital: "BV Chấn Thương Chỉnh Hình", experience: 9 },
      { name: "BS. Đặng Văn G", specialty: "Thần kinh", hospital: "BV Việt Đức", experience: 14 },
      { name: "BS. Hoàng Thị H", specialty: "Sản phụ khoa", hospital: "BV Từ Dũ", experience: 13 },
      { name: "BS. Phan Văn I", specialty: "Nhi khoa", hospital: "BV Nhi Đồng 1", experience: 10 },
      { name: "BS. Trương Thị K", specialty: "Tổng quát", hospital: "BV Nhân Dân Gia Định", experience: 7 }
    ];
    await Doctor.insertMany(doctors);
    console.log("🌱 Đã seed dữ liệu bác sĩ mẫu!");
  }
}

await seedDoctorsIfNeeded();

/* -------------------- Gemini setup -------------------- */
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

/* -------------------- Helpers -------------------- */

// Heuristic specialty detection (rule-based)
function detectSpecialty(text = '') {
  const t = text.toLowerCase();
  if (/(bụng|dạ dày|tiêu chảy|táo bón|buồn nôn|nôn|ợ nóng|trào ngược|tiêu hóa)/.test(t)) return 'Tiêu hoá';
  if (/(tim|huyết áp|đau ngực|mạch|nhồi máu|cao huyết áp|tức ngực)/.test(t)) return 'Tim mạch';
  if (/(da|mụn|dị ứng|mẩn đỏ|ngứa|chàm|vẩy nến|mề đay|da liễu)/.test(t)) return 'Da liễu';
  if (/(tai|mũi|họng|viêm xoang|ù tai|viêm amidan)/.test(t)) return 'Tai mũi họng';
  if (/(ho|khó thở|hen|viêm phổi|viêm phế quản|đờm)/.test(t)) return 'Hô hấp';
  if (/(xương|khớp|đau lưng|viêm khớp|gai cột sống|gút|gut|gout)/.test(t)) return 'Cơ xương khớp';
  if (/(đau đầu|chóng mặt|mất ngủ|động kinh|run tay|tê)/.test(t)) return 'Thần kinh';
  if (/(kinh nguyệt|rong kinh|mang thai|vô sinh|thai sản|phụ khoa)/.test(t)) return 'Sản phụ khoa';
  if (/(trẻ|bé|sốt cao|tiêu chảy trẻ em|ho trẻ)/.test(t)) return 'Nhi khoa';
  return 'Tổng quát';
}

// Heuristic quick yes/no recognition (user short reply when pending)
// ------------------ Helpers ------------------
function normalizeInput(input) {
  return input
    ?.trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, ""); // bỏ dấu
}

function isAffirmativeShort(input) {
  const txt = normalizeInput(input);
  if (!txt) return false;
  return ["co", "ok", "yes", "dong y", "d"].includes(txt);
}

function isNegativeShort(input) {
  const txt = normalizeInput(input);
  if (!txt) return false;
  return ["khong", "ko", "no", "k"].includes(txt);
}

// detectDoctorIntent: try fast regex first, fallback to Gemini if ambiguous
async function detectDoctorIntent(question) {
  if (!question || !question.trim()) return false;
  const t = question.toLowerCase();

  // quick heuristics (Vietnamese + English)
  const wantRegex = /\b(muốn|cần|gặp|khám|cho tôi bác sĩ|tư vấn|được tư vấn|xin gặp)\b/;
  const notRegex = /\b(không|chưa|không muốn|ko|từ chối)\b/;

  if (wantRegex.test(t) && !notRegex.test(t)) return true;
  if (notRegex.test(t) && !wantRegex.test(t)) return false;

  // ambiguous -> fallback to model (ask model to answer only yes/no or có/không)
  try {
    const prompt = `
Bạn là bộ phân loại ngôn ngữ tiếng Việt. Nhiệm vụ: chỉ trả về một từ duy nhất: "yes" nếu người dùng muốn gặp bác sĩ, "no" nếu không.
Không giải thích. Câu người dùng: """${question}"""
`;
    const result = await model.generateContent(prompt);
    const raw = (result?.response?.text?.() ?? '').toLowerCase();
    // check vietnamese/english
    if (raw.includes('yes') || raw.includes('có')) return true;
    if (raw.includes('no') || raw.includes('không')) return false;
    return false;
  } catch (err) {
    console.error('detectDoctorIntent error:', err);
    return false;
  }
}

// Build prompt content using last N messages + summary to reduce token usage
function buildAssistantPrompt(convo, roleHint = "Mediverse, một y tá") {
  // lấy tối đa 10 tin nhắn cuối thôi
  const lastMessages = convo.messages.slice(-10).map(m => `${m.role}: ${m.content}`).join("\n");
  const summaryPart = convo.summary ? `Tóm tắt hội thoại trước đó: ${convo.summary}\n\n` : "";

  return `
Bạn là ${roleHint}.
${summaryPart}
Đây là các tin nhắn gần đây:
${lastMessages}

Hãy trả lời ngắn gọn, thân thiện, chỉ bằng tiếng Việt.
`;
}


// Update conversation summary using model when messages are long
async function maybeUpdateSummary(convo) {
  try {
    if (!convo || !Array.isArray(convo.messages)) return;
    const THRESHOLD = 30;

    if (convo.messages.length >= THRESHOLD) {
      const toSummarize = convo.messages.slice(0, -10).map(m => `${m.role}: ${m.content}`).join("\n");
      const prompt = `
Bạn là một trợ lý y tế. Hãy tóm tắt nội dung chính trong đoạn hội thoại này bằng 2-3 câu, bằng tiếng Việt.
${toSummarize}
`;
      const r = await model.generateContent(prompt);
      const summary = (r?.response?.text?.() ?? "").trim();
      if (summary) {
        convo.summary = convo.summary
          ? `${convo.summary} / ${summary}`
          : summary;
        // giữ lại 10 tin nhắn gần nhất thôi
        convo.messages = convo.messages.slice(-10);
        await convo.save();
      }
    }
  } catch (err) {
    console.error("maybeUpdateSummary error", err);
  }
}


/* -------------------- Routes -------------------- */

/** Health check */
app.get('/', (_, res) => res.send('AI chat + doctor flow backend OK 🚑'));

/** Create conversation */
app.post('/conversation', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    const convo = new Conversation({ userId, messages: [] });
    await convo.save();
    res.json({ success: true, id: convo._id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** List conversations (delete empty convs first) */
app.get('/conversations/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    await Conversation.deleteMany({ userId, messages: { $size: 0 } });
    const convos = await Conversation.find({ userId }).populate('doctor pendingDoctor').sort({ createdAt: -1 }).lean();
    const previews = convos.map(c => ({
      id: c._id,
      createdAt: c.createdAt,
      preview: c.messages.length ? c.messages[c.messages.length - 1].content.slice(0, 80) : '(Không có nội dung)',
      doctor: c.doctor || null,
      pendingDoctor: c.pendingDoctor || null
    }));
    res.json({ success: true, conversations: previews });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** Get conversation detail */

// ------------------ Chat endpoint ------------------
app.post("/chat/:conversationId", async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { question } = req.body;
    if (!question)
      return res
        .status(400)
        .json({ success: false, error: "question is required" });

    const convo = await Conversation.findById(conversationId).populate(
      "doctor pendingDoctor"
    );
    if (!convo)
      return res
        .status(404)
        .json({ success: false, error: "Conversation not found" });

    // Save user message
    convo.messages.push({ role: "user", content: question });

    // 1) If pendingDoctor -> wait for user confirm (short answers)
    if (convo.pendingDoctor) {
      if (isAffirmativeShort(question)) {
        convo.doctor = convo.pendingDoctor;
        convo.pendingDoctor = null;
        convo.lastAskPending = false;

        const notify = `✅ Bạn đã được kết nối với bác sĩ ${convo.doctor.name} (${convo.doctor.specialty}).`;
        convo.messages.push({ role: "assistant", content: notify });
        await convo.save();
        maybeUpdateSummary(convo);
        return res.json({ success: true, answer: notify, conversation: convo });
      } else if (isNegativeShort(question)) {
        convo.pendingDoctor = null;
        convo.lastAskPending = false;

        const notify =
          "❌ Bạn đã từ chối chuyển sang bác sĩ. Tôi sẽ tiếp tục hỗ trợ bạn.";
        convo.messages.push({ role: "assistant", content: notify });
        await convo.save();
        maybeUpdateSummary(convo);
        return res.json({ success: true, answer: notify, conversation: convo });
      } else {
        // tránh lặp vô tận
        if (!convo.lastAskPending) {
          convo.lastAskPending = true;
          const ask =
            "Bạn có muốn chuyển tiếp sang bác sĩ được gợi ý không? (Có / Không)";
          convo.messages.push({ role: "assistant", content: ask });
          await convo.save();
          return res.json({ success: true, answer: ask, conversation: convo });
        } else {
          convo.lastAskPending = false;
          const fallback =
            "Xin lỗi, tôi chưa hiểu. Bạn hãy trả lời rõ: Có hoặc Không.";
          convo.messages.push({ role: "assistant", content: fallback });
          await convo.save();
          return res.json({
            success: true,
            answer: fallback,
            conversation: convo,
          });
        }
      }
    }

    // 2) If already connected to doctor -> forward to doctor-prompt
    if (convo.doctor) {
      const doctor = convo.doctor;
      const roleHint = `bác sĩ ${doctor.name}, chuyên khoa ${doctor.specialty}`;
      const prompt =
        buildAssistantPrompt(convo, roleHint) +
        `\nNgười bệnh hỏi: "${question}"\n`;
      let answer = "(Xin lỗi, hiện tại hệ thống không phản hồi được)";
      try {
        const r = await model.generateContent(prompt);
        answer = r?.response?.text?.() ?? answer;
      } catch (err) {
        console.error("doctor generate error", err);
        answer = "(Hệ thống bác sĩ đang bận, thử lại sau)";
      }
      convo.messages.push({ role: "assistant", content: answer });
      await convo.save();
      maybeUpdateSummary(convo);
      return res.json({
        success: true,
        answer,
        conversation: convo,
        doctor,
      });
    }

    // 3) Otherwise (no doctor, not pending) -> detect intent
    const needDoctor = await detectDoctorIntent(question);

    if (needDoctor) {
      const suggestedSpecialty = detectSpecialty(question);
      const triage = new Triage({
        userId: convo.userId,
        symptoms: question,
        suggestedSpecialty,
        conversationId: convo._id,
      });
      await triage.save();

      const doctor = await Doctor.findOne({
        specialty: { $regex: new RegExp(suggestedSpecialty, "i") },
      });

      if (doctor) {
        convo.pendingDoctor = doctor._id;
        convo.lastAskPending = false;
        const confirmMsg = `Tôi gợi ý bác sĩ ${doctor.name} (${doctor.specialty}). Bạn có muốn chuyển tiếp để được tư vấn không? (Có / Không)`;
        convo.messages.push({ role: "assistant", content: confirmMsg });
        await convo.save();
        maybeUpdateSummary(convo);
        return res.json({
          success: true,
          answer: confirmMsg,
          conversation: convo,
          triage,
          pendingDoctor: doctor,
        });
      } else {
        const fallback = `Hiện tại chưa có bác sĩ chuyên khoa ${suggestedSpecialty} khả dụng. Tôi sẽ tiếp tục hỗ trợ bạn.`;
        convo.messages.push({ role: "assistant", content: fallback });
        await convo.save();
        maybeUpdateSummary(convo);
        return res.json({
          success: true,
          answer: fallback,
          conversation: convo,
          triage,
        });
      }
    }

    // 4) If not needing doctor -> answer as Mediverse (nurse)
    const prompt = buildAssistantPrompt(convo, "Mediverse, một y tá");
    const fullPrompt = `${prompt}\nNgười dùng: "${question}"\n`;
    let aiAnswer = "(Xin lỗi, hệ thống hiện không trả lời được)";
    try {
      const r = await model.generateContent(fullPrompt);
      aiAnswer = r?.response?.text?.() ?? aiAnswer;
    } catch (err) {
      console.error("ai generate error", err);
      aiAnswer = "(Hệ thống đang bận, thử lại sau)";
    }

    convo.messages.push({ role: "assistant", content: aiAnswer });
    await convo.save();
    maybeUpdateSummary(convo);

    return res.json({ success: true, answer: aiAnswer, conversation: convo });
  } catch (err) {
    console.error("/chat error", err);
    res.status(500).json({ success: false, error: err.message });
  }
});


/** Triage API (direct) */
app.post('/triage', async (req, res) => {
  try {
    const { userId, symptoms } = req.body;
    if (!symptoms) return res.status(400).json({ success: false, error: 'symptoms required' });

    const suggestedSpecialty = detectSpecialty(symptoms);
    const triage = new Triage({ userId, symptoms, suggestedSpecialty });
    await triage.save();

    const doctor = await Doctor.findOne({ specialty: suggestedSpecialty, available: true }) || null;
    res.json({ success: true, triage, doctor });
  } catch (err) {
    console.error('/triage error', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** Temp conversation endpoints (optional) */
app.post('/temp-conversation', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const tc = new TempConversation({ userId, messages: [] });
    await tc.save();
    res.json({ success: true, id: tc._id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/temp-chat/:tempConversationId', async (req, res) => {
  try {
    const { tempConversationId } = req.params;
    const { question } = req.body;
    if (!question) return res.status(400).json({ error: 'question required' });

    const temp = await TempConversation.findById(tempConversationId);
    if (!temp) return res.status(404).json({ error: 'TempConversation not found' });

    temp.messages.push({ role: 'user', content: question });

    // Use same detectDoctorIntent + triage logic as above
    const needDoctor = await detectDoctorIntent(question);
    let triage = null;
    let doctor = null;
    if (needDoctor) {
      const suggestedSpecialty = detectSpecialty(question);
      triage = new Triage({ userId: temp.userId, symptoms: question, suggestedSpecialty });
      await triage.save();
      doctor = await Doctor.findOne({ specialty: suggestedSpecialty, available: true }) || null;
      if (doctor) {
        // add assistant confirm in temp convo
        const confirm = `Bạn có muốn chuyển tiếp sang bác sĩ ${doctor.name} (${doctor.specialty}) không? (Có / Không)`;
        temp.messages.push({ role: 'assistant', content: confirm });
        await temp.save();
        return res.json({ success: true, answer: confirm, messages: temp.messages, triage, doctor });
      }
    }

    // else call model as Mediverse
    const system = temp.systemInstructions || 'You are Mediverse, a nurse — respond in Vietnamese.';
    const history = temp.messages.map(m => `${m.role}: ${m.content}`).join('\n');
    const prompt = `${system}\n\nLịch sử:\n${history}\n\nHãy trả lời ngắn gọn.`;
    let answer = '(Không có phản hồi)';
    try {
      const r = await model.generateContent(prompt);
      answer = r?.response?.text?.() ?? answer;
    } catch (err) {
      console.error('temp-chat model error', err);
    }
    temp.messages.push({ role: 'assistant', content: answer });
    await temp.save();
    res.json({ success: true, answer, messages: temp.messages, triage, doctor });
  } catch (err) {
    console.error('/temp-chat error', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** End temp conversation -> create real Conversation (optional) */
app.post('/end-temp-conversation/:tempConversationId', async (req, res) => {
  try {
    const { tempConversationId } = req.params;
    const temp = await TempConversation.findById(tempConversationId);
    if (!temp) return res.status(404).json({ error: 'TempConversation not found' });
    const convo = new Conversation({ userId: temp.userId, messages: temp.messages });
    await convo.save();
    await temp.deleteOne();
    res.json({ success: true, conversation: convo });
  } catch (err) {
    console.error('/end-temp-conversation error', err);
    res.status(500).json({ error: err.message });
  }
});
// Doctor Info API
app.get("/doctor-info", async (req, res) => {
  try {
    const { userId } = req.query;

    // Lấy 3 hội thoại gần nhất có populate bác sĩ
    const recent = await Conversation.find({ userId })
      .populate("doctor")
      .sort({ createdAt: -1 })
      .limit(3)
      .lean();

    // Danh sách bác sĩ từ hội thoại
    const doctors = recent
      .map(c => c.doctor)
      .filter(Boolean);

    // Gợi ý 1 bác sĩ khả dụng
    const suggested = await Doctor.findOne({ available: true });

    res.json({ success: true, recent: doctors, suggested });
  } catch (err) {
    console.error("Error fetching doctor info:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});
/** Create conversation with doctor */
app.post('/doctor-conversation', async (req, res) => {
  try {
    const { userId, doctorId } = req.body;
    if (!userId || !doctorId) return res.status(400).json({ error: 'userId and doctorId required' });

    const doctor = await Doctor.findById(doctorId);
    if (!doctor) return res.status(404).json({ error: 'Doctor not found' });

    // tạo hội thoại mới gắn bác sĩ
    const convo = new Conversation({
      userId,
      doctor: doctor._id,
      messages: [
        {
          role: "system",
          content: `Bạn là bác sĩ ${doctor.name}, chuyên ngành ${doctor.specialty}, làm việc tại ${doctor.hospital} với ${doctor.experience} năm kinh nghiệm. 
          Bạn có kiến thức vừa phải, hãy tư vấn ngắn gọn, bằng tiếng Việt.`
        }
      ]
    });
    await convo.save();

    res.json({ success: true, conversation: convo });
  } catch (err) {
    console.error("/doctor-conversation error", err);
    res.status(500).json({ success: false, error: err.message });
  }
});
app.post('/doctor-chat/:conversationId', async (req, res) => {
  const { conversationId } = req.params;
  const { question } = req.body;
  // load conversation
  const convo = await Conversation.findById(conversationId).populate('doctor');
  if (!convo) return res.status(404).json({ success: false, error: 'Conversation not found' });
  if (!convo.doctor) return res.status(400).json({ success: false, error: 'This conversation has no doctor' });

  // thêm message user
  convo.messages.push({ role: "user", content: question });

  // build prompt với thông tin bác sĩ
  const doctor = convo.doctor;
  const prompt = buildAssistantPrompt(convo, `bác sĩ ${doctor.name}, chuyên khoa ${doctor.specialty}`)
               + `\nNgười bệnh: "${question}"\n`;

  let answer = "(Xin lỗi, bác sĩ chưa trả lời được)";
  try {
    const r = await model.generateContent(prompt);
    answer = r?.response?.text?.() ?? answer;
  } catch (err) {
    console.error("doctor-chat error:", err);
  }

  convo.messages.push({ role: "assistant", content: answer });
  await convo.save();
  res.json({ success: true, answer, conversation: convo });
});

/* -------------------- Start server -------------------- */
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
