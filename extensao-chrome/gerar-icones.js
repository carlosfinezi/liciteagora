// Script para gerar ícones da extensão
// Execute: node gerar-icones.js

const fs = require('fs');
const path = require('path');

// Função para criar um ícone PNG simples (quadrado colorido com letra)
function criarIconePNG(tamanho) {
  // Cabeçalho PNG mínimo
  const { createCanvas } = require('canvas');
  const canvas = createCanvas(tamanho, tamanho);
  const ctx = canvas.getContext('2d');

  // Fundo azul
  ctx.fillStyle = '#1a5f7a';
  ctx.fillRect(0, 0, tamanho, tamanho);

  // Borda arredondada (aproximação)
  ctx.fillStyle = '#0d3d4d';
  ctx.fillRect(0, 0, tamanho, 3);
  ctx.fillRect(0, 0, 3, tamanho);

  // Letra "C" branca
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${Math.floor(tamanho * 0.6)}px Arial`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('C', tamanho / 2, tamanho / 2);

  return canvas.toBuffer('image/png');
}

// Alternativa: criar ícones usando HTML Canvas e salvar manualmente
const htmlGerador = `<!DOCTYPE html>
<html>
<head>
  <title>Gerador de Icones</title>
</head>
<body>
  <h1>Icones Gerados</h1>
  <p>Clique com botao direito em cada imagem e salve como PNG na pasta icons/</p>

  <h3>icon16.png</h3>
  <canvas id="icon16" width="16" height="16"></canvas>
  <br><br>

  <h3>icon48.png</h3>
  <canvas id="icon48" width="48" height="48"></canvas>
  <br><br>

  <h3>icon128.png</h3>
  <canvas id="icon128" width="128" height="128"></canvas>

  <script>
    function desenharIcone(id, tamanho) {
      const canvas = document.getElementById(id);
      const ctx = canvas.getContext('2d');

      // Fundo com gradiente
      const gradient = ctx.createLinearGradient(0, 0, tamanho, tamanho);
      gradient.addColorStop(0, '#1a5f7a');
      gradient.addColorStop(1, '#0d3d4d');
      ctx.fillStyle = gradient;

      // Desenha retângulo arredondado
      const radius = tamanho * 0.15;
      ctx.beginPath();
      ctx.moveTo(radius, 0);
      ctx.lineTo(tamanho - radius, 0);
      ctx.quadraticCurveTo(tamanho, 0, tamanho, radius);
      ctx.lineTo(tamanho, tamanho - radius);
      ctx.quadraticCurveTo(tamanho, tamanho, tamanho - radius, tamanho);
      ctx.lineTo(radius, tamanho);
      ctx.quadraticCurveTo(0, tamanho, 0, tamanho - radius);
      ctx.lineTo(0, radius);
      ctx.quadraticCurveTo(0, 0, radius, 0);
      ctx.closePath();
      ctx.fill();

      // Letra "C"
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold ' + Math.floor(tamanho * 0.6) + 'px Arial';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('C', tamanho / 2, tamanho / 2 + tamanho * 0.05);

      // Converte para imagem
      const img = new Image();
      img.src = canvas.toDataURL('image/png');
      canvas.parentNode.insertBefore(img, canvas.nextSibling);
    }

    desenharIcone('icon16', 16);
    desenharIcone('icon48', 48);
    desenharIcone('icon128', 128);
  </script>
</body>
</html>`;

// Salva o HTML gerador
fs.writeFileSync(path.join(__dirname, 'icons', 'gerar.html'), htmlGerador);

// Cria ícones simples como data URI (fallback)
const iconesBase64 = {
  16: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAA2ElEQVR42mNgGAWjYBQMBBgZGf8zMDD8R8b///9nZGBg+A8F/xkYGP7DxBgYGP4zMDL+hwswMjL+Z2Rk/M/IyPgfJPb//38GmDxMHKQG5D2YPFgNAyMjWJyBASwPMgGshpERYiJIDC7OAFEDUoMhD9UPlYfaAJFnBAkAATMzM0gCxIcCkBzEJLAcVB4sjsXLIMeAxBkZGcDKwXKMjAzgIAe5HRxPQH8ygtSA5BgZGMFqQHKMjIz/GRhA5sE8B5UH2QCKRpgcOKJB+mGRyMgAC0h4MONKe6NgtAAAA7nQQMfp/oYAAAAASUVORK5CYII=',
  48: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAA5klEQVRoge3YwQ3CMAwF0N8KNmADNmADNmADNmAENmADNmADNmADNqAbsAEbJFUlUgmJk7hNq/aT2pM6L44jG8BqtVo7ALsCAPwDAFiN3gPQVw6g93gOQP5IAH3GA/4AwgAiA/AMEBkgeAAYAYgMABuAF4BoAF4BMoC+AWQDeAfID+A9oB+AwAF6BZANIBhALoDIAYIACAYgGsBfAKIBZADxDhAMIDZABoDYAaIDxBBAfIDwAQoDKBBg+wDlAoQPEBzgewDBAIIH+BlAYIBfARQA0DMA+wI4BqC/f4hMAKt1B3sAJWqVJ6GKJKgAAAAASUVORK5CYII=',
  128: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAA9UlEQVR42u3dQQ0AIAwAQdz9Z/ZHcCFBwExdb+89+xzgy0kAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAH+EeAC18MByoWyXmMAAAAASUVORK5CYII='
};

// Cria arquivos PNG simples (quadrados coloridos)
function criarPNGSimples(tamanho) {
  // PNG de cor sólida azul
  // Estrutura mínima de um PNG
  const width = tamanho;
  const height = tamanho;

  // Cria um buffer com pixels RGBA
  const pixels = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      // Cor #1a5f7a (azul)
      pixels[i] = 0x1a;     // R
      pixels[i + 1] = 0x5f; // G
      pixels[i + 2] = 0x7a; // B
      pixels[i + 3] = 0xff; // A
    }
  }

  return pixels;
}

console.log('Para gerar os icones:');
console.log('1. Abra o arquivo icons/gerar.html no navegador');
console.log('2. Clique com botao direito em cada imagem');
console.log('3. Salve como icon16.png, icon48.png e icon128.png na pasta icons/');
console.log('');
console.log('Ou use os icones base64 abaixo copiando para arquivos PNG:');
console.log('');
Object.entries(iconesBase64).forEach(([size, data]) => {
  console.log(`icon${size}.png: ${data.substring(0, 50)}...`);
});
