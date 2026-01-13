require("dotenv").config();

/* =====================
   IMPORTS
===================== */
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const nodemailer = require("nodemailer");
const { v4: uuidv4 } = require("uuid");
const { createCanvas, loadImage } = require("canvas");
const QRCode = require("qrcode");
const { WebhookClient } = require("dialogflow-fulfillment");
const { createClient } = require("@supabase/supabase-js");

const {
  GoogleGenerativeAI,
} = require("@google/generative-ai");

/* =====================
   CONFIG
===================== */
const PORT = process.env.PORT || 8080;
const MODEL_NAME = "gemini-2.5-flash-lite";

/* =====================
   SUPABASE
===================== */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

/* =====================
   EXPRESS APP
===================== */
const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => {
  res.send("Server running 🚀");
});

/* =====================
   STATIC FOLDER
===================== */
const cardsDir = path.join(__dirname, "cards");
if (!fs.existsSync(cardsDir)) fs.mkdirSync(cardsDir);
app.use("/cards", express.static(cardsDir));

/* =====================
   EMAIL
===================== */
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

/* =====================
   GEMINI AI
===================== */
async function runGemini(queryText) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: MODEL_NAME });

  const result = await model.generateContent(queryText);
  return result.response.text();
}

/* =====================
   HELPERS
===================== */
function getParamValue(param) {
  if (!param) return null;
  if (typeof param === "string") return param;
  if (Array.isArray(param)) return getParamValue(param[0]);
  if (typeof param === "object") return param.name || param.value || null;
  return null;
}

function extractName(agent) {
  const params = agent.parameters || {};
  return (
    getParamValue(params.name) ||
    getParamValue(params.person) ||
    getParamValue(params["given-name"]) ||
    agent.query ||
    "Not Provided"
  );
}

/* =====================
   DIALOGFLOW WEBHOOK
===================== */
app.post("/webhook", async (req, res) => {
  const agent = new WebhookClient({ request: req, response: res });

 function hi(agent) {
        console.log(`intent  =>  hi`);
        agent.add("WELCOME TO SMIT TRAINING CENTER");
    }

  /* ---- ADMISSION INTENT ---- */
  async function admissionDetails(agent) {
    const params = agent.parameters || {};
    const name = extractName(agent);
    const course = getParamValue(params.course) || "Not Provided";
    const email = getParamValue(params.email);

    if (!name || name === "Not Provided") {
      agent.add("Please tell me your full name.");
      return;
    }

    const studentId = uuidv4().slice(0, 8);
    const fileName = `ID_${studentId}.pdf`;
    const filePath = path.join(cardsDir, fileName);
    const pdfUrl = `${req.protocol}://${req.get("host")}/cards/${fileName}`;

    /* ---- CANVAS CARD ---- */
    const width = 350;
    const height = 220;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    ctx.fillStyle = "#f4f6f8";
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = "#1e40af";
    ctx.fillRect(0, 0, width, 45);

    ctx.fillStyle = "#fff";
    ctx.font = "bold 16px Arial";
    ctx.fillText("SAYLANI MASS IT TRAINING", 45, 30);

    ctx.fillStyle = "#000";
    ctx.font = "13px Arial";
    ctx.fillText(`Name: ${name}`, 15, 80);
    ctx.fillText(`Course: ${course}`, 15, 110);
    ctx.fillText(`Student ID: ${studentId}`, 15, 140);

    const qrPayload = { studentId, name, course };
    const qrDataURL = await QRCode.toDataURL(JSON.stringify(qrPayload));
    const qrImage = await loadImage(qrDataURL);
    ctx.drawImage(qrImage, 230, 80, 90, 90);

    ctx.strokeStyle = "#1e40af";
    ctx.lineWidth = 3;
    ctx.strokeRect(0, 0, width, height);

    /* ---- PDF ---- */
    const doc = new PDFDocument({ size: [width, height], margin: 0 });
    doc.pipe(fs.createWriteStream(filePath));
    doc.image(canvas.toBuffer("image/png"), 0, 0);
    doc.end();

    /* ---- SAVE DB ---- */
    await supabase.from("students").insert([{
      student_id: studentId,
      name,
      course,
      email,
      qr_data: qrPayload,
      pdf_url: pdfUrl,
    }]);

    /* ---- EMAIL ---- */
    if (email) {
      await transporter.sendMail({
        from: `"Saylani Mass IT Training" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: "Admission Confirmed 🎉",
        html: `
          <h3>Admission Confirmed</h3>
          <p><b>Name:</b> ${name}</p>
          <p><b>Course:</b> ${course}</p>
          <p><b>Student ID:</b> ${studentId}</p>
          <p><a href="${pdfUrl}">Download ID Card</a></p>
        `,
      });
    }

    agent.add(`✅ Admission Successful!\nStudent ID: ${studentId}`);
  }

  /* ---- FALLBACK (GEMINI) ---- */
  async function fallback(agent) {
    const queryText = agent.query;
    const reply = await runGemini(queryText);
    agent.add(reply);
  }

  /* ---- INTENT MAP ---- */
  const intentMap = new Map();
  intentMap.set("Admission.Details", admissionDetails);
  intentMap.set("Admission.Start", hi);
  intentMap.set("Default Fallback Intent", fallback);

  agent.handleRequest(intentMap);
});

/* =====================
   START SERVER
===================== */
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
