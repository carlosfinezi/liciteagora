# Trocar o slug de um tenant

Não há rota para isso, e a ordem importa. Feito uma vez, em 29/09/2026
(`floricultura` → `cantinhoverde`, depois de apagar um `cantinhoverde` de
teste).

O slug é três coisas ao mesmo tempo: o endereço, o nome da pasta em
`data/tenants/` e a chave do pool de conexões dos dois processos. Por isso a
sequência não tem variante:

1. backup;
2. no `control.db`, `UPDATE tenants SET slug, db_path` e uma linha em
   `tenant_audit` (`RENAME_SLUG`). Apagar tenant é `DELETE FROM tenants` com
   `PRAGMA foreign_keys=ON`, que leva módulos e cobrança pelo `CASCADE`;
3. `mv` da pasta em `data/tenants/`;
4. **restart dos dois serviços na hora.** O pool guarda a conexão pelo slug:
   sem o restart, o slug reaproveitado continuaria servindo o banco antigo;
5. `v-delete-web-domain carlosfinezi <antigo>.liciteagora.app yes` e
   `/usr/local/sbin/liciteagora-provision-vhost <novo>`;
6. resselar o FIM com os arquivos de `/etc/nginx/conf.d/domains/` que mudaram.

As imagens da loja guardam o slug antigo no nome do arquivo
(`logo-floricultura-…`). Isso é só nome, e continua servindo.
