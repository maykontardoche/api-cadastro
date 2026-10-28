# Lista de senhas comuns

`common-passwords.txt` é a blocklist usada pela política de senha: uma senha nova que aparece na
lista é recusada com `common_password`.

## Origem

- **Fonte:** [SecLists](https://github.com/danielmiessler/SecLists),
  `Passwords/Common-Credentials/Pwdb_top-1000000.txt`, commit
  `12274c98fdebe98c7a7284914436a472ed469aed` (baixado em 2026-10-28).
- **Licença:** MIT, Copyright (c) 2018 Daniel Miessler.

## Como foi gerada

A política exige no mínimo 15 caracteres, e quase todas as senhas mais comuns são menores que
isso. Por isso a lista guarda só as entradas que a política aceitaria: de 15 a 128 caracteres,
contados por code point depois da normalização NFKC, em minúsculas e sem repetição. Restaram
5.328 entradas.

```bash
node scripts/build-password-blocklist.mjs Pwdb_top-1000000.txt src/modules/auth/data/common-passwords.txt
```

A comparação também é feita em minúsculas, então `MinhaSenha...` e `minhasenha...` contam como a
mesma senha.
