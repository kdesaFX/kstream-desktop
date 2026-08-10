const DiscordRPC = require('discord-rpc');
const CLIENT_ID = '1536251834203770941';
DiscordRPC.register(CLIENT_ID);
const client = new DiscordRPC.Client({ transport: 'ipc' });
client.on('ready', async () => {
  console.log('ready as', client.user && client.user.username);
  await client.request('SET_ACTIVITY', {
    pid: process.pid,
    activity: {
      type: 3,
      details: 'Once Upon a Time... in Hollywood',
      state: 'Status test — check your Discord profile',
      timestamps: { start: Date.now() },
      instance: false,
    },
  });
  console.log('Test presence is LIVE for 90 seconds. Check your Discord profile now.');
  setTimeout(() => {
    client.destroy();
    process.exit(0);
  }, 90000);
});
client.login({ clientId: CLIENT_ID }).catch((e) => {
  console.error(e);
  process.exit(1);
});
