'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { URL } = require('node:url');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const BOOKINGS_FILE = path.join(DATA_DIR, 'bookings.json');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY_BYTES = 16 * 1024;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 20;

const services = [
  { name: 'Маникюр без покрытия', duration: '45 мин', price: 'от 80 zł' },
  { name: 'Маникюр с покрытием', duration: '90 мин', price: 'от 130 zł' },
  { name: 'Укрепление ногтей', duration: '105 мин', price: 'от 150 zł' },
  { name: 'Наращивание ногтей', duration: '150 мин', price: 'от 210 zł' },
  { name: 'Коррекция наращённых ногтей', duration: '120 мин', price: 'от 180 zł' },
  { name: 'Дизайн ногтей', duration: 'от 15 мин', price: 'от 10 zł' },
  { name: 'Педикюр с покрытием', duration: '100 мин', price: 'от 160 zł' },
  { name: 'Smart-педикюр', duration: '90 мин', price: 'от 170 zł' }
];

const masters = [
  'Любой свободный мастер',
  'Анна Левицкая',
  'Мария Новак',
  'София Коваль',
  'Дарья Вишневская'
];

const times = ['09:00', '10:30', '12:00', '13:30', '15:00', '16:30', '18:00', '19:30'];
const rateLimits = new Map();

class HttpError extends Error {
  constructor(status, message, field) {
    super(message);
    this.status = status;
    this.field = field;
  }
}

function setSecurityHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' https://images.unsplash.com data:; connect-src 'self'");
  if (process.env.NODE_ENV === 'production') {
    response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

function sendBody(response, status, body, contentType, cacheControl) {
  let output = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const acceptEncoding = String(response.req?.headers?.['accept-encoding'] || '').toLowerCase();
  const compressible = contentType.startsWith('text/') || contentType.startsWith('application/json');

  if (compressible && output.length >= 512) {
    if (/\bbr\b/.test(acceptEncoding)) {
      output = zlib.brotliCompressSync(output, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } });
      response.setHeader('Content-Encoding', 'br');
    } else if (/\bgzip\b/.test(acceptEncoding)) {
      output = zlib.gzipSync(output, { level: 6 });
      response.setHeader('Content-Encoding', 'gzip');
    }
    response.setHeader('Vary', 'Accept-Encoding');
  }

  response.statusCode = status;
  response.setHeader('Content-Type', contentType);
  response.setHeader('Cache-Control', cacheControl);
  response.setHeader('Content-Length', output.length);
  response.end(output);
}

function sendJson(response, status, payload) {
  sendBody(response, status, JSON.stringify(payload), 'application/json; charset=utf-8', 'no-store');
}

function clean(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, maxLength);
}

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

function readBookings() {
  try {
    const data = fs.readFileSync(BOOKINGS_FILE, 'utf8');
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new HttpError(500, 'Не удалось прочитать записи');
  }
}

function writeBookings(bookings) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temporaryFile = `${BOOKINGS_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(bookings, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporaryFile, BOOKINGS_FILE);
}

function validateBooking(payload, bookings) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new HttpError(400, 'Некорректное тело запроса');
  }

  const requestId = clean(payload.clientRequestId, 80);
  const name = clean(payload.name, 80);
  const phone = clean(payload.phone, 32);
  const telegram = clean(payload.telegram, 64);
  const instagram = clean(payload.instagram, 64);
  const comment = clean(payload.comment, 600);
  const date = clean(payload.date, 10);
  const time = clean(payload.time, 5);
  const serviceIndex = payload.serviceIndex;
  const masterIndex = payload.masterIndex;

  if (!requestId) throw new HttpError(400, 'Не удалось определить заявку', 'clientRequestId');
  if (name.length < 2) throw new HttpError(400, 'Укажите имя', 'name');
  if (!/^[+\d()\s-]{5,32}$/.test(phone)) throw new HttpError(400, 'Укажите корректный телефон', 'phone');
  if (!Number.isInteger(serviceIndex) || !services[serviceIndex]) throw new HttpError(400, 'Выберите услугу', 'service');
  if (!Number.isInteger(masterIndex) || !masters[masterIndex]) throw new HttpError(400, 'Выберите мастера', 'master');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'Выберите корректную дату', 'date');
  if (!times.includes(time)) throw new HttpError(400, 'Выберите доступное время', 'time');
  if (payload.consent !== true) throw new HttpError(400, 'Нужно согласиться с правилами записи', 'consent');

  const selectedDate = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(selectedDate.getTime())) throw new HttpError(400, 'Выберите корректную дату', 'date');
  const today = new Date();
  const minDate = dateKey(today);
  const maxDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 31));
  if (date < minDate || selectedDate > maxDate) throw new HttpError(400, 'Дата должна быть в ближайшие 31 день', 'date');

  const existingByRequest = bookings.find((booking) => booking.requestId === requestId);
  if (existingByRequest) return { duplicate: true, booking: existingByRequest };

  const sameSlot = bookings.some((booking) => (
    booking.status === 'pending' &&
    booking.date === date &&
    booking.time === time &&
    booking.masterIndex === masterIndex
  ));
  if (sameSlot && masterIndex !== 0) throw new HttpError(409, 'Это время уже занято у выбранного мастера', 'time');

  const service = services[serviceIndex];
  const booking = {
    id: crypto.randomUUID(),
    requestId,
    status: 'pending',
    createdAt: new Date().toISOString(),
    serviceIndex,
    service: service.name,
    duration: service.duration,
    price: service.price,
    masterIndex,
    master: masters[masterIndex],
    date,
    time,
    contact: { name, phone, telegram, instagram, comment }
  };

  return { duplicate: false, booking };
}

function consumeRateLimit(request) {
  const key = request.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const recent = (rateLimits.get(key) || []).filter((timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX) return false;
  recent.push(now);
  rateLimits.set(key, recent);
  return true;
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
      else tooLarge = true;
    });
    request.on('end', () => {
      if (tooLarge) return reject(new HttpError(413, 'Запрос слишком большой'));
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'Ожидался корректный JSON'));
      }
    });
    request.on('error', () => reject(new HttpError(400, 'Не удалось прочитать запрос')));
  });
}

function mimeType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.png')) return 'image/png';
  if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) return 'image/jpeg';
  return 'application/octet-stream';
}

function servePage(request, response, pathname) {
  const pageName = pathname === '/' ? 'index.html' : pathname.slice(1);
  const allowedPages = new Set(['index.html', 'privacy.html', 'booking-rules.html', 'certificates.html']);
  if (!allowedPages.has(pageName) || pageName.includes('..')) {
    sendJson(response, 404, { error: 'Страница не найдена' });
    return;
  }

  const filePath = path.resolve(ROOT, pageName);
  if (!filePath.startsWith(`${ROOT}${path.sep}`)) {
    sendJson(response, 403, { error: 'Доступ запрещён' });
    return;
  }

  try {
    const stats = fs.statSync(filePath);
    const etag = `W/"${stats.size}-${Math.floor(stats.mtimeMs)}"`;
    response.setHeader('ETag', etag);
    response.setHeader('Last-Modified', stats.mtime.toUTCString());
    if (request.headers['if-none-match'] === etag) {
      response.statusCode = 304;
      response.end();
      return;
    }
    const body = fs.readFileSync(filePath);
    sendBody(response, 200, body, mimeType(filePath), 'public, max-age=300, must-revalidate');
  } catch (error) {
    if (error.code === 'ENOENT') sendJson(response, 404, { error: 'Страница не найдена' });
    else sendJson(response, 500, { error: 'Не удалось открыть страницу' });
  }
}

const server = http.createServer(async (request, response) => {
  setSecurityHeaders(response);
  const requestUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  try {
    if (requestUrl.pathname === '/api/health' && request.method === 'GET') {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (requestUrl.pathname === '/api/bookings' && request.method === 'POST') {
      if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
        throw new HttpError(415, 'Используйте Content-Type: application/json');
      }
      if (!consumeRateLimit(request)) throw new HttpError(429, 'Слишком много попыток. Попробуйте позже');
      const payload = await readRequestBody(request);
      const bookings = readBookings();
      const result = validateBooking(payload, bookings);
      if (!result.duplicate) writeBookings([...bookings, result.booking]);
      sendJson(response, result.duplicate ? 200 : 201, {
        ok: true,
        booking: {
          id: result.booking.id,
          service: result.booking.service,
          master: result.booking.master,
          date: result.booking.date,
          time: result.booking.time,
          price: result.booking.price
        }
      });
      return;
    }

    if (request.method === 'GET') {
      servePage(request, response, requestUrl.pathname);
      return;
    }

    sendJson(response, 405, { error: 'Метод не поддерживается' });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (!(error instanceof HttpError)) console.error('Request failed:', error.message);
    sendJson(response, status, { error: error instanceof HttpError ? error.message : 'Внутренняя ошибка сервера', field: error.field });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`LUMÉ NAILS server is running at http://${HOST}:${PORT}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
