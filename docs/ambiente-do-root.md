# O ambiente do root, cópia do ambiente do carlosfinezi

As sessões desta pasta rodam como root, e o root só carrega o que está em
`/root/.claude`. Leia este documento quando atualizar skill, plugin ou o
CLAUDE.md global do carlosfinezi: nada aqui se atualiza sozinho.

As sessões daqui rodam como root, e o root só carrega o que está em
`/root/.claude`. Em 29/09/2026 ele recebeu o mesmo conjunto do carlosfinezi,
tudo de posse do root e sem nada executando arquivo da home dele. Nada disso
se atualiza sozinho. Atualizou lá, o root refaz aqui:

- **Skills** `impeccable`, `motion-design` e `graphify` em
  `/root/.claude/skills/`: recopiar com `cp -r`, `chown -R root:root` e
  `chmod 755` no `impeccable/scripts/impeccable`, que vem sem o bit. Duas
  diferenças a recolocar depois da cópia: o `craft-floor.md` do Impeccable
  leva cinco regras que só a variante do Codex (`~/.agents`) tinha, e o
  `SKILL.md` do graphify leva no topo a seção "LiciteAgora: consultar, nunca
  construir".
- **Binário do Impeccable**: o launcher baixa sozinho para
  `/root/.impeccable/bin/<versão>` a versão do `scripts/VERSION`.
- **Ponytail 4.9.0**, com os ganchos: marketplace de diretório em
  `/root/.claude/plugin-sources/ponytail`, um clone do
  `DietrichGebert/ponytail` parado no `356918e`, o mesmo commit do
  carlosfinezi. O marketplace do GitHub não fixa commit, e o `main` já está na
  4.10.0. Para atualizar: `git -C` no clone com `fetch` e `checkout` da nova
  referência, depois `claude plugin marketplace update ponytail` e
  `claude plugin update ponytail@ponytail`.
- **Graphify**: o programa fica na venv `/root/.local/share/graphifyy`
  (`graphifyy[sql]==0.9.56`) e se atualiza com
  `python3 -m pip --python /root/.local/share/graphifyy/bin/python install "graphifyy[sql]==<versão>"`.
  A consulta é pelo `graphify-liciteagora` (`/root/.local/bin`), que só lê o
  grafo do carlosfinezi. O grafo continua sendo reconstruído por ele, pelo
  `su - carlosfinezi`.
- **CLAUDE.md global**: `/root/.claude/CLAUDE.md` é cópia do
  `/home/carlosfinezi/.claude/CLAUDE.md`, a recopiar quando aquele mudar. O
  anterior, o Karpathy Guidelines, está em
  `/root/.claude/CLAUDE.md.karpathy-antes-2026-09-29`.
- **Gancho do Impeccable: LIGADO**, na chave `hooks` do
  `/root/.claude/settings.json` (cópia do bloco em
  `/root/.claude/impeccable-hook.json`). Ele roda depois de cada Edit ou Write
  e no fim do turno, só sobre arquivo dentro da pasta da sessão, e avisa no
  contexto o que achou, sem bloquear. O cache vai para fora do projeto
  (`IMPECCABLE_CACHE_ROOT=/root/.impeccable/hook-cache`). O que ele grava no
  repositório é um bloco `# impeccable-hook-ignore-start`, uma vez só, no
  `.git/info/exclude`. Esse arquivo não é versionado e não aparece no
  `git status`, e o bloco foi aceito em 29/09.

Nesta árvore, não rode sem perguntar `impeccable hooks ignore-*`, `init`,
`document` nem o modo `live`: eles gravam `.impeccable/`, `PRODUCT.md` ou
`DESIGN.md` aqui dentro.

