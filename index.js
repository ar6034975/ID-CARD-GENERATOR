require("dotenv").config();

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
const { GoogleGenerativeAI } = require("@google/generative-ai");
const MODEL_NAME = "gemini-2.5-flash";

/***********************
 * SUPABASE CLIENT
 ***********************/
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

/***********************
 * GEMINI CLIENT
 ***********************/
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: MODEL_NAME });

async function askGemini(prompt) {
  try {
    const result = await geminiModel.generateContent({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
    });

    const response = result.response;
    if (!response || !response.candidates?.length) {
      return "I’m here to help. Please ask again.";
    }

    return response.candidates[0].content.parts[0].text;
  } catch (err) {
    console.error("❌ Gemini Error:", err);
    return "Sorry, I am unable to answer right now.";
  }
}

/***********************
 * APP CONFIG
 ***********************/
const app = express();
app.use(cors());
app.use(bodyParser.json());
const PORT = process.env.PORT || 8080;

app.get("/", (req, res) => res.send("Server running 🚀"));

/***********************
 * STATIC FOLDER
 ***********************/
const cardsDir = path.join(__dirname, "cards");
if (!fs.existsSync(cardsDir)) fs.mkdirSync(cardsDir);
app.use("/cards", express.static(cardsDir));

/***********************
 * EMAIL TRANSPORTER
 ***********************/
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

/***********************
 * HELPERS
 ***********************/
function getParamValue(param) {
  if (!param) return null;
  if (typeof param === "string") return param;
  if (Array.isArray(param)) return getParamValue(param[0]);
  if (typeof param === "object") {
    if (param.name) return param.name;
    if (param.value) return param.value;
  }
  return null;
}

function extractName(agent) {
  const params = agent.parameters || {};
  return (
    getParamValue(params.name) ||
    getParamValue(params.person) ||
    getParamValue(params["given-name"]) ||
    getParamValue(params.fullname) ||
    "Not Provided"
  );
}

/***********************
 * WEBHOOK
 ***********************/
app.post("/webhook", async (req, res) => {
  const agent = new WebhookClient({ request: req, response: res });

  async function admissionDetails(agent) {
    const params = agent.parameters || {};

    const name = extractName(agent);
    const course = getParamValue(params.course) || "Not Provided";
    const email = getParamValue(params.email) || null;

    if (!name || name === "Not Provided") {
      agent.add("Please tell me your full name.");
      return;
    }

    const studentId = uuidv4().slice(0, 8);
    const fileName = `ID_${studentId}.pdf`;
    const filePath = path.join(cardsDir, fileName);
    const pdfUrl = `${req.protocol}://${req.get("host")}/cards/${fileName}`;

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

    const doc = new PDFDocument({ size: [width, height], margin: 0 });
    doc.pipe(fs.createWriteStream(filePath));
    doc.image(canvas.toBuffer("image/png"), 0, 0);
    doc.end();

    await supabase.from("students").insert([
      {
        student_id: studentId,
        name,
        course,
        email,
        qr_data: qrPayload,
        pdf_url: pdfUrl,
      },
    ]);

    if (email) {
      await transporter.sendMail({
        from: `"Saylani Mass IT Training" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: "Admission Confirmed 🎉",
        html: `
          <p><b>Name:</b> ${name}</p>
          <p><b>Course:</b> ${course}</p>
          <p><b>Student ID:</b> ${studentId}</p>
          <p><a href="${pdfUrl}">Download ID Card</a></p>
        `,
      });
    }

    const aiCongrats = await askGemini(
      `Congratulate ${name} for successful admission in ${course} at Saylani Mass IT Training in one short sentence.`
    );

    agent.add(`✅ Admission Successful!\nStudent ID: ${studentId}`);
    agent.add(aiCongrats);
  }

  async function fallback(agent) {
    const userMessage =
      agent.request_?.body?.queryResult?.queryText || "User needs help";

    const aiReply = await askGemini(
      `You are an admission assistant for Saylani Mass IT Training.
User message: "${userMessage}"
Reply politely and briefly.`
    );

    agent.add(aiReply);
  }

  function hi(agent) {
    agent.add("Hi! I am the AI assistant of Saylani Mass IT Training.");
  }

  const intentMap = new Map();
  intentMap.set("Default Welcome Intent", hi);
 intentMap.set("Default Fallback Intent", fallback);
 intentMap.set("Admission Details", admissionDetails);
 
  try {
    agent.handleRequest(intentMap);
  } catch (err) {
    console.error(err);
    agent.add("Something went wrong. Please try again.");
  }
});

/***********************
 * START SERVER
 ***********************/
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
