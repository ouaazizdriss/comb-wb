-- SSH tunnels for connections that are only reachable through a bastion.
alter table connections
  add column ssh_host      text,
  add column ssh_port      int not null default 22,
  add column ssh_user      text,
  add column ssh_auth      text check (ssh_auth in ('password','key')),
  add column ssh_secret_enc bytea,            -- password or private key (PEM), envelope-encrypted
  add column ssh_host_key  text;              -- pinned SHA256 fingerprint of the bastion's host key
