// Script para criar ícones PNG simples
// Execute: node criar-icones.js

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Função para criar CRC32
function crc32(data) {
  let crc = 0xffffffff;
  const table = [];

  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }

  for (let i = 0; i < data.length; i++) {
    crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

// Função para criar chunk PNG
function createChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typeBuffer = Buffer.from(type, 'ascii');
  const crcData = Buffer.concat([typeBuffer, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcData), 0);

  return Buffer.concat([length, typeBuffer, data, crc]);
}

// Função para criar PNG
function createPNG(width, height, r, g, b) {
  // Signature PNG
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type (RGB)
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // IDAT chunk (pixel data)
  const rawData = [];
  for (let y = 0; y < height; y++) {
    rawData.push(0); // filter byte para cada linha
    for (let x = 0; x < width; x++) {
      // Gradiente simples
      const factor = 1 - (x + y) / (width + height) * 0.3;
      rawData.push(Math.floor(r * factor));
      rawData.push(Math.floor(g * factor));
      rawData.push(Math.floor(b * factor));
    }
  }

  const compressed = zlib.deflateSync(Buffer.from(rawData), { level: 9 });

  // IEND chunk
  const iend = Buffer.alloc(0);

  // Monta o PNG
  return Buffer.concat([
    signature,
    createChunk('IHDR', ihdr),
    createChunk('IDAT', compressed),
    createChunk('IEND', iend)
  ]);
}

// Cria os ícones
const iconsDir = path.join(__dirname, 'icons');

if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir);
}

// Cor azul #1a5f7a = RGB(26, 95, 122)
const sizes = [16, 48, 128];

sizes.forEach(size => {
  const png = createPNG(size, size, 26, 95, 122);
  const filename = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(filename, png);
  console.log(`Criado: ${filename} (${png.length} bytes)`);
});

console.log('\\nIcones criados com sucesso!');
