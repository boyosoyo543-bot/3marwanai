import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  normalizeMessageContent
} from '@whiskeysockets/baileys'

import pino from 'pino'
import fs from 'fs'
import path from 'path'
import pdfParse from 'pdf-parse'

const AUTH_DIR =
  process.env.AUTH_DIR || './auth'

const DATA_DIR =
  process.env.DATA_DIR || './data'

const KNOWLEDGE_DIR =
  process.env.KNOWLEDGE_DIR || './knowledge'

const USERS_FILE =
  path.join(DATA_DIR, 'users.json')

const PHONE =
  (process.env.PHONE || '')
    .replace(/[^0-9]/g, '')

const GROQ_API_KEY =
  process.env.GROQ_API_KEY || ''

const GROQ_MODEL =
  process.env.GROQ_MODEL ||
  'meta-llama/llama-4-scout-17b-16e-instruct'

const logger =
  pino({ level: 'silent' })

const users = new Map()
const chunks = []

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms))

const SUBJECTS = [
  'الرياضيات',
  'الفيزياء والكيمياء',
  'علوم الحياة والأرض',
  'اللغة العربية',
  'اللغة الفرنسية',
  'الاجتماعيات',
  'التاريخ',
  'الجغرافيا',
  'التربية الإسلامية'
]

function ensureDirs() {
  fs.mkdirSync(AUTH_DIR, {
    recursive: true
  })

  fs.mkdirSync(DATA_DIR, {
    recursive: true
  })

  fs.mkdirSync(KNOWLEDGE_DIR, {
    recursive: true
  })

  if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(
      USERS_FILE,
      '{}',
      'utf8'
    )
  }
}

function loadUsers() {
  try {
    const saved = JSON.parse(
      fs.readFileSync(
        USERS_FILE,
        'utf8'
      )
    )

    for (
      const [id, value]
      of Object.entries(saved)
    ) {
      users.set(id, value)
    }
  } catch (error) {
    console.log(
      'USERS LOAD ERROR:',
      error.message
    )
  }
}

function saveUsers() {
  fs.writeFileSync(
    USERS_FILE,
    JSON.stringify(
      Object.fromEntries(users),
      null,
      2
    ),
    'utf8'
  )
}

function getContent(message) {
  return (
    normalizeMessageContent(
      message.message
    ) || message.message
  )
}

function getText(content) {
  return (
    content?.conversation ||
    content?.extendedTextMessage?.text ||
    content?.imageMessage?.caption ||
    content?.documentMessage?.caption ||
    ''
  ).trim()
}

function getUser(id) {
  if (!users.has(id)) {
    users.set(id, {
      level: null,
      subject: null,
      history: []
    })
  }

  return users.get(id)
}

function walk(dir) {
  const result = []

  const items =
    fs.readdirSync(
      dir,
      { withFileTypes: true }
    )

  for (const item of items) {
    const full =
      path.join(dir, item.name)

    if (item.isDirectory()) {
      result.push(...walk(full))
    } else {
      result.push(full)
    }
  }

  return result
}

function inferMeta(file) {
  const name =
    file.toLowerCase()

  const level =
    name.includes('3ac') ||
    name.includes('3-ac') ||
    name.includes('الثالثة')
      ? '3ac'
      : 'general'

  const subject =
    SUBJECTS.find(subject =>
      name.includes(
        subject.toLowerCase()
      )
    ) || 'general'

  return {
    level,
    subject,
    file: path.relative(
      KNOWLEDGE_DIR,
      file
    )
  }
}

function addChunks(text, meta) {
  const clean =
    text
      .replace(/\s+/g, ' ')
      .trim()

  if (!clean) return

  const size = 1800
  const overlap = 250

  for (
    let i = 0;
    i < clean.length;
    i += size - overlap
  ) {
    const part =
      clean.slice(i, i + size).trim()

    if (part.length > 80) {
      chunks.push({
        text: part,
        ...meta
      })
    }
  }
}

async function loadKnowledge() {
  chunks.length = 0

  const files =
    walk(KNOWLEDGE_DIR)

  for (const file of files) {
    const extension =
      path.extname(file).toLowerCase()

    try {
      let text = ''

      if (extension === '.pdf') {
        const parsed =
          await pdfParse(
            fs.readFileSync(file)
          )

        text = parsed.text
      } else if (
        [
          '.txt',
          '.md',
          '.csv',
          '.json'
        ].includes(extension)
      ) {
        text = fs.readFileSync(
          file,
          'utf8'
        )
      } else {
        continue
      }

      addChunks(
        text,
        inferMeta(file)
      )
    } catch (error) {
      console.log(
        'KNOWLEDGE ERROR:',
        file,
        error.message
      )
    }
  }

  console.log(
    `Knowledge loaded: ${chunks.length} chunks from ${files.length} files`
  )
}

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[ًٌٍَُِّْـ]/g, '')
    .trim()
}

function retrieve(query, user) {
  const words =
    normalize(query)
      .split(/[^\p{L}\p{N}]+/u)
      .filter(word => word.length > 2)

  const wantedLevel = '3ac'

  const wantedSubject =
    normalize(user.subject)

  return chunks
    .map(chunk => {
      const hay =
        normalize(
          `${chunk.text} ${chunk.file}`
        )

      let score =
        words.reduce(
          (sum, word) =>
            sum +
            (hay.includes(word)
              ? 2
              : 0),
          0
        )

      if (
        chunk.level === wantedLevel ||
        chunk.level === 'general'
      ) {
        score += 5
      }

      if (
        wantedSubject &&
        (
          normalize(chunk.subject) ===
            wantedSubject ||
          chunk.subject === 'general'
        )
      ) {
        score += 4
      }

      return {
        ...chunk,
        score
      }
    })
    .filter(item => item.score > 0)
    .sort((a, b) =>
      b.score - a.score
    )
    .slice(0, 5)
}

function systemPrompt(user, context) {
  return `
أنت مساعد دراسي ذكي من تطوير المبرمج مروان، ومخصص لتلميذ في الثالثة إعدادي بالمغرب.

المادة الحالية هي:
${user.subject || 'غير محددة'}

مهمتك شرح الدرس من الصفر بطريقة واضحة وهادئة.
ابدأ بالفكرة البسيطة، ثم شرح المفاهيم، ثم مثال من الحياة أو مثال محلول، ثم خلاصة قصيرة، ثم سؤال صغير للتأكد من الفهم.

هضر مع التلميذ بشكل عادي ومحترم.
يمكنك ذكر أن البوت من تطوير مروان عند الحاجة، ولكن لا تقل إنك مروان، ولا تنسب شخصية التلميذ أو المساعد إلى مروان.

ما تعطيش شرحاً طويلاً دفعة واحدة.
قسم الدرس إلى مراحل قصيرة.
بعد كل مرحلة سول:
"واش فهمتي هاد الجزء؟"

إذا قال التلميذ:
"ما فهمتش"
فلا تكرر نفس الكلام.
استعمل كلمات أبسط ومثالاً جديداً وتشبيهاً واضحاً.

إذا قال:
"فهمت"
فكمل للمرحلة التالية.

إذا طلب التلميذ شرح درس، قدم بالترتيب:

1. الفكرة العامة.
2. شنو خاصو يعرف قبل.
3. شرح المفاهيم.
4. مثال بسيط.
5. مثال محلول.
6. الأخطاء الشائعة.
7. تمرين صغير للتأكد من الفهم.

إذا صيفط صورة تمرين:
- اقرأ ما يظهر فقط.
- إذا الصورة غير واضحة قل ذلك.
- حدد المطلوب.
- شرح الحل خطوة بخطوة.
- لا تقفز مباشرة إلى الجواب النهائي.

استعمل قاعدة المعرفة الموجودة تحت كمرجع.
لا تخترع معلومة أو رقماً.
إذا لم تجد التفصيل، قل بوضوح إنك تحتاج مرجعاً إضافياً.

في آخر كل جواب تعليمي سول سؤال فهم واحد فقط.

قاعدة المعرفة:
${context || 'لا توجد وثائق مناسبة بعد.'}
`
}

async function askAI(
  user,
  text,
  imageBuffer,
  mime
) {
  if (!GROQ_API_KEY) {
    throw new Error(
      'أضف GROQ_API_KEY في Railway Variables.'
    )
  }

  const found =
    retrieve(text, user)

  const context =
    found
      .map((item, index) =>
        `[مرجع ${index + 1}: ${item.file}]\n${item.text}`
      )
      .join('\n\n')

  const content = []

  if (text) {
    content.push({
      type: 'text',
      text
    })
  }

  if (imageBuffer) {
    content.push({
      type: 'image_url',
      image_url: {
        url:
          `data:${mime};base64,` +
          imageBuffer.toString('base64')
      }
    })
  }

  const messages = [
    {
      role: 'system',
      content: systemPrompt(
        user,
        context
      )
    },
    ...(user.history || []).slice(-8),
    {
      role: 'user',
      content:
        imageBuffer
          ? content
          : text
    }
  ]

  const response =
    await fetch(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization:
            `Bearer ${GROQ_API_KEY}`,
          'Content-Type':
            'application/json'
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          messages,
          temperature: 0.15,
          max_tokens: 2800
        })
      }
    )

  const data =
    await response.json()

  if (!response.ok) {
    throw new Error(
      data?.error?.message ||
      `Groq HTTP ${response.status}`
    )
  }

  const answer =
    data?.choices?.[0]?.message?.content
      ?.trim()

  if (!answer) {
    throw new Error(
      'النموذج ما رجع حتى جواب.'
    )
  }

  user.history = [
    ...(user.history || []),
    {
      role: 'user',
      content: text || '[صورة]'
    },
    {
      role: 'assistant',
      content: answer
    }
  ].slice(-10)

  saveUsers()

  return answer
}

function detectLevel(text) {
  const n =
    normalize(text)

  if (
    n.includes('3 اعدادي') ||
    n.includes('الثالثة اعدادي') ||
    n.includes('الثالثة إعدادي')
  ) {
    return 'الثالثة إعدادي'
  }

  return null
}

function detectSubject(text) {
  const n =
    normalize(text)

  return SUBJECTS.find(subject =>
    n.includes(normalize(subject))
  ) || null
}

function help() {
  return `
مرحبا بك في المساعد الدراسي من تطوير مروان، مخصص للثالثة إعدادي.

كتب:
- 3 إعدادي
- مادة الرياضيات
- مادة اللغة العربية
- مادة الاجتماعيات

ومن بعد كتب اسم الدرس أو سول على أي حاجة ما فهمتيهاش.
تقدر حتى تصيفط صورة تمرين.

الأوامر:
help
reset
`
}

async function start() {
  ensureDirs()
  loadUsers()
  await loadKnowledge()

  const {
    state,
    saveCreds
  } = await useMultiFileAuthState(
    AUTH_DIR
  )

  const {
    version
  } = await fetchLatestBaileysVersion()

  const sock =
    makeWASocket({
      version,
      auth: state,
      logger
    })

  let pairingRequested = false

  sock.ev.on(
    'creds.update',
    saveCreds
  )

  sock.ev.on(
    'connection.update',
    async ({
      connection,
      lastDisconnect,
      qr
    }) => {
      if (
        qr &&
        !pairingRequested &&
        !sock.authState.creds.registered &&
        PHONE
      ) {
        pairingRequested = true

        try {
          const code =
            await sock.requestPairingCode(
              PHONE
            )

          console.log(
            'PAIRING CODE:',
            code
          )
        } catch (error) {
          console.log(
            'PAIRING ERROR:',
            error.message
          )

          pairingRequested = false
        }
      }

      if (connection === 'open') {
        console.log(
          'Education bot connected'
        )
      }

      if (connection === 'close') {
        const code =
          lastDisconnect
            ?.error
            ?.output
            ?.statusCode

        if (
          code !==
          DisconnectReason.loggedOut
        ) {
          await sleep(3000)
          start()
        } else {
          console.log(
            'Logged out.'
          )
        }
      }
    }
  )

  sock.ev.on(
    'messages.upsert',
    async ({ messages }) => {
      for (const message of messages) {
        try {
          if (
            !message.message ||
            message.key.fromMe
          ) {
            continue
          }

          const chatId =
            message.key.remoteJid

          // البوت يخدم غير فالخاص
          if (
            chatId.endsWith('@g.us')
          ) {
            continue
          }

          const content =
            getContent(message)

          const text =
            getText(content)

          const lower =
            normalize(text)

          const user =
            getUser(chatId)

          if (
            lower === 'help' ||
            lower === 'مساعدة' ||
            lower === 'سلام'
          ) {
            await sock.sendMessage(
              chatId,
              {
                text: help()
              }
            )

            continue
          }

          if (
            lower === 'reset' ||
            lower === 'مسح'
          ) {
            users.delete(chatId)
            saveUsers()

            await sock.sendMessage(
              chatId,
              {
                text:
                  'تم المسح. كتب 3 إعدادي من جديد.'
              }
            )

            continue
          }

          const level =
            detectLevel(text)

          if (level) {
            user.level = level
            user.subject = null
            user.history = []

            saveUsers()

            await sock.sendMessage(
              chatId,
              {
                text:
                  `✅ تسجل المستوى: ${level}\n` +
                  'دابا كتب المادة.'
              }
            )

            continue
          }

          const subject =
            detectSubject(text)

          if (
            subject &&
            (
              lower.startsWith('مادة') ||
              text.length < 35
            )
          ) {
            user.subject = subject

            saveUsers()

            await sock.sendMessage(
              chatId,
              {
                text:
                  `✅ تسجلات المادة: ${subject}\n` +
                  'صيفط اسم الدرس أو السؤال.'
              }
            )

            continue
          }

          if (!user.level) {
            await sock.sendMessage(
              chatId,
              {
                text:
                  'مرحبا بك في المساعد الدراسي من تطوير مروان.\n' +
                  'كتب: 3 إعدادي باش نبدأو.'
              }
            )

            continue
          }

          if (!user.subject) {
            await sock.sendMessage(
              chatId,
              {
                text:
                  'حدد المادة، مثلاً:\n' +
                  'مادة الرياضيات\n' +
                  'مادة اللغة العربية\n' +
                  'مادة الاجتماعيات'
              }
            )

            continue
          }

          const image =
            content?.imageMessage

          let imageBuffer = null
          let mime = 'image/jpeg'

          if (image) {
            await sock.sendMessage(
              chatId,
              {
                text:
                  '⏳ كنقرا التمرين ونقلب فالمراجع المناسبة...'
              }
            )

            imageBuffer =
              await downloadMediaMessage(
                message,
                'buffer',
                {},
                {
                  logger,
                  reuploadRequest:
                    old =>
                      sock.updateMediaMessage(
                        old
                      )
                }
              )

            mime =
              image.mimetype ||
              mime
          }

          const answer =
            await askAI(
              user,
              text ||
                'حل هذا التمرين المصور واشرحه خطوة بخطوة بطريقة مناسبة للثالثة إعدادي.',
              imageBuffer,
              mime
            )

          await sock.sendMessage(
            chatId,
            {
              text: answer
            }
          )
        } catch (error) {
          console.log(
            'MESSAGE ERROR:',
            error.message
          )

          try {
            await sock.sendMessage(
              message.key.remoteJid,
              {
                text:
                  `وقع مشكل: ${error.message}`
              }
            )
          } catch {}
        }
      }
    }
  )
}

start()
