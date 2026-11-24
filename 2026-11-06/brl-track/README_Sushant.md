# BRL Track — install on the bestroadways.com server

Customer link format: `https://bestroadways.com/t/<10 letters>`. No RoaDo / vendor name ever shows to the customer.

## 1 · Prerequisites (your prep mail)
- Node 22 (`node -v`), pm2 (`npm i -g pm2`)
- MySQL database `brl_track` and a user with full rights on it only

## 2 · Install
```
mkdir -p /opt/brl-track && cd /opt/brl-track
unzip ~/brl-track.zip -d .
npm install --omit=dev
cp config.sample.js config.js
node cli.js keys          # prints internal_key and push_secret
```
Edit `config.js`: put the MySQL host/user/password/database, and paste the two keys.
**Never send the keys or the DB password by mail or WhatsApp.** Give `internal_key` to Shishir on a call.

```
node cli.js setup         # creates the tables
npm test                  # must end "All 23 checks passed."
pm2 start server.js --name brl-track && pm2 save && pm2 startup
```

## 3 · nginx (inside the bestroadways.com https server block)
```
location /t/ {
    proxy_pass http://127.0.0.1:3090/;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header Host $host;
}
```
`nginx -t && systemctl reload nginx`

## 4 · Checks
- `https://bestroadways.com/t/health` → `{"ok":true}`
- `node cli.js stats` → after the first robot run, "last sync" shows a time
- `node cli.js lr <LR no.>` → status, place, link of one LR

## 5 · Switch on the robots (Shishir / Chaitrali — not by mail)
- Master robot project → Project settings → Script properties:
  `T59_URL = https://bestroadways.com/t` and `T59_KEY = <internal_key>`
- Each KAM sheet → script 40t: T59 URL `https://bestroadways.com/t/api/lr` and the same key

From the next hourly run, every market-vehicle LR gets its bestroadways.com link in the "Tracking · Link" column, and the transit mails use it.

## Send back
Screenshots of `npm test`, `/t/health` in a browser, and `pm2 status`.
