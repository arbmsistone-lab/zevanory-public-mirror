const names=["TELEGRAM_BOT_TOKEN","TELEGRAM_CHANNEL_ID","YOUTUBE_CLIENT_ID","YOUTUBE_CLIENT_SECRET","YOUTUBE_REFRESH_TOKEN","PINTEREST_ACCESS_TOKEN","PINTEREST_BOARD_ID","PINTEREST_CLIENT_ID","PINTEREST_CLIENT_SECRET"];
const credentials={};for(const name of names){const value=String(process.env[name]||"").trim();if(value)credentials[name]=value;}
if(!credentials.TELEGRAM_BOT_TOKEN||!credentials.TELEGRAM_CHANNEL_ID)throw new Error("telegram_credentials_missing");
process.stdout.write(JSON.stringify(credentials));
