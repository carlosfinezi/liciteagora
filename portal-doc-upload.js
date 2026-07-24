// portal-doc-upload.js
//
// Upload + anexo de documentos de proposta em BNC/BLL (mesmo protocolo).
// Engenharia reversa 2026-07-13. Fluxo (por documento exigido):
//   1) GET /Proposal/ParticipantProposalDocument?param1=<trId>&param2=<idProcessDocument>&param3=<row>&param4=<mandatory>
//      → partial com idParticipantDocument, fkDocument, fkProcessDocument, ContainerId (jsonForm3/4).
//   2) GET /Upload/SASToken?containerId=<c>&filename=<name> → { AccountUrl, ContainerName, ServerFilename, SASToken }.
//   3) PUT <AccountUrl>/<ContainerName>/<ServerFilename>?<SASToken>  (x-ms-blob-type: BlockBlob) — sobe o arquivo no Azure.
//   4) POST /Proposal/ParticipantProposalDocument (jsonForm3: Filename, ServerFileNameUpload=<blob>, IssueDate,
//      ExpirationDate, idParticipantDocument, fkDocument, fkProcessDocument) → registra o doc do participante.
//   5) POST /Proposal/ParticipantProposalDocumentAttach?param1=idParticipantDocument&param2=fkProcessDocument&param3=row&param4=mandatory
//      → anexa à proposta (a linha some do "faltando" e vira anexada).
//
// `portal` = { get(db, path, headers), post(db, path, body, headers), base }  (bnc-client / bll-client).

'use strict';

const https = require('https');

function attrs(tag) {
  const o = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(tag)) !== null) { const k = m[1].toLowerCase(); if (k in o) continue; o[k] = m[3] ?? m[4] ?? m[5]; }
  return o;
}
function inputVal(html, name) {
  const re = new RegExp(`<input\\b[^>]*\\bname\\s*=\\s*["']?${name}["']?[^>]*>`, 'i');
  const m = html.match(re);
  return m ? (attrs(m[0]).value ?? '') : null;
}
function encodeForm(pairs) {
  return pairs.map(([k, v]) => `${encodeURIComponent(k).replace(/%20/g, '+')}=${encodeURIComponent(String(v ?? '')).replace(/%20/g, '+')}`).join('&');
}

// PUT do arquivo direto no Azure Blob (BlockBlob single-shot; SAS dá create+write).
function putAzureBlob(accountUrl, container, blobName, sasToken, buf, contentType) {
  return new Promise((resolve) => {
    const u = new URL(`${accountUrl}/${container}/${encodeURIComponent(blobName)}?${sasToken}`);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'PUT',
      headers: { 'x-ms-blob-type': 'BlockBlob', 'x-ms-version': '2023-11-03', 'Content-Type': contentType || 'application/octet-stream', 'Content-Length': buf.length },
    }, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d.slice(0, 300) })); });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.write(buf); req.end();
  });
}

function respErro(resp) {
  // envelope AJAX { modal:'error', html } do portal
  try { const j = JSON.parse(resp.body || ''); if (j && String(j.modal || '').toLowerCase() === 'error') return String(j.html || '').replace(/<[^>]*>/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 250) || 'erro do portal'; } catch (e) {}
  return null;
}

// doc = { index(row), idProcessDocument, trId } — vindos da tabela #tableDocumentsAttached.
// file = { buffer, filename, contentType }.
async function anexarDocumento(portal, db, { doc, file, issueDate = '', expirationDate = '' }) {
  const mandatory = 'SIM';
  const row = String(doc.index);
  // 1) partial do documento (pega idParticipantDocument / fkDocument / ContainerId)
  const pUrl = `/Proposal/ParticipantProposalDocument?param1=${encodeURIComponent(doc.trId)}&param2=${encodeURIComponent(doc.idProcessDocument)}&param3=${encodeURIComponent(row)}&param4=${mandatory}`;
  const pr = await portal.get(db, pUrl, { Accept: 'text/html,*/*' });
  let phtml = pr.body || '';
  try { const j = JSON.parse(phtml); if (j.html) phtml = j.html; } catch (e) {}
  const idParticipantDocument = inputVal(phtml, 'idParticipantDocument');
  const fkDocument = inputVal(phtml, 'fkDocument');
  const fkProcessDocument = inputVal(phtml, 'fkProcessDocument') || doc.idProcessDocument;
  const containerId = inputVal(phtml, 'ContainerId') || '2';
  const expDefault = inputVal(phtml, 'ExpirationDate') || '';
  if (!idParticipantDocument) { const e = new Error('Não consegui abrir o formulário de documento do portal (idParticipantDocument ausente).'); e.code = 'DOC_PARTIAL'; throw e; }

  // 2) SAS token
  const sr = await portal.get(db, `/Upload/SASToken?containerId=${encodeURIComponent(containerId)}&filename=${encodeURIComponent(file.filename)}`, { Accept: 'application/json,*/*' });
  let sas; try { sas = JSON.parse(sr.body); } catch (e) { const err = new Error('SASToken inválido do portal.'); err.code = 'DOC_SAS'; throw err; }
  if (!sas || !sas.SASToken || sas.error) { const err = new Error('SASToken: ' + (sas && sas.error ? sas.error : 'resposta inesperada')); err.code = 'DOC_SAS'; throw err; }

  // 3) PUT no Azure
  const put = await putAzureBlob(sas.AccountUrl, sas.ContainerName, sas.ServerFilename, sas.SASToken, file.buffer, file.contentType);
  if (put.status !== 201) { const err = new Error(`Upload ao armazenamento falhou (HTTP ${put.status}).`); err.code = 'DOC_AZURE'; err.detalhe = put.body || put.error; throw err; }

  // 4) salva o documento do participante (jsonForm3)
  const savePayload = encodeForm([
    ['IssueDate', issueDate],
    ['ExpirationDate', expirationDate || expDefault],
    ['Reference', ''],
    ['Filename', file.filename],
    ['ServerFileNameUpload', sas.ServerFilename],
    ['idParticipantDocument', idParticipantDocument],
    ['fkDocument', fkDocument],
    ['fkProcessDocument', fkProcessDocument],
  ]);
  const save = await portal.post(db, '/Proposal/ParticipantProposalDocument', savePayload, { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' });
  const saveErr = respErro(save);
  if (saveErr) { const err = new Error(`O portal recusou o documento: ${saveErr}`); err.code = 'DOC_SAVE'; throw err; }

  // 5) anexa à proposta
  const attachUrl = `/Proposal/ParticipantProposalDocumentAttach?param1=${encodeURIComponent(idParticipantDocument)}&param2=${encodeURIComponent(fkProcessDocument)}&param3=${encodeURIComponent(row)}&param4=${mandatory}`;
  const att = await portal.post(db, attachUrl, '', { 'Content-Type': 'application/json;charset=utf-8', Accept: 'application/json,*/*' });
  const attErr = respErro(att);
  if (attErr) { const err = new Error(`Falha ao anexar: ${attErr}`); err.code = 'DOC_ATTACH'; throw err; }

  return { ok: true, filename: file.filename, serverFilename: sas.ServerFilename, idParticipantDocument };
}

module.exports = { anexarDocumento, _interno: { putAzureBlob, inputVal } };
