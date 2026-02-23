



const { 
    Client, 
    GatewayIntentBits, 
    EmbedBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    Partials 
} = require('discord.js');
const fs = require('fs');

// --- CONFIGURATION ---
const TOKEN = 'MTQ3MTg4NTgyODExNTY2MTAwMw.Gjb2e3.Q-CO4wL3sstWOa07N0c5Z8_hiX8Z6hCNhsZZkU';
const TARGET_GUILD = '1471793632955728049';
const COMMAND_CHANNEL = '1475538453679575101';
const OWNER_USERNAME = 'firr.dev';
const DATA_FILE = './database.json';

// --- DATABASE INITIALIZATION ---
let db = {
    users: {},       // { userId: { invites: 0, points: 0, blacklisted: false } }
    history: {},     // { joinedUserId: [inviterId1, inviterId2] } - Tracks who invited who
    pending: {},     // { joinedUserId: { inviter: inviterId, time: timestamp } } - For the 1h point system
    spamTrack: {}    // { inviterId_joinedUserId: count } - Tracks join/leave spam
};

if (fs.existsSync(DATA_FILE)) {
    db = JSON.parse(fs.readFileSync(DATA_FILE));
}

function saveData() {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

function getUser(id) {
    if (!db.users[id]) db.users[id] = { invites: 0, points: 0, blacklisted: false };
    return db.users[id];
}

// --- CLIENT SETUP ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildInvites,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages
    ],
    partials: [Partials.Channel]
});

// Cache for invites
const invitesCache = new Map();

client.on('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    
    const guild = client.guilds.cache.get(TARGET_GUILD);
    if (guild) {
        try {
            const firstInvites = await guild.invites.fetch();
            invitesCache.set(guild.id, new Map(firstInvites.map(inv => [inv.code, inv.uses])));
        } catch (err) {
            console.log("Could not fetch invites on startup.");
        }
    }

    // 1-Hour Point Checker Loop (runs every 1 minute)
    setInterval(() => {
        const now = Date.now();
        for (const [joinedId, data] of Object.entries(db.pending)) {
            // 3600000 ms = 1 hour
            if (now - data.time >= 3600000) {
                const inviterData = getUser(data.inviter);
                if (!inviterData.blacklisted) {
                    inviterData.points += 1;
                    saveData();
                }
                delete db.pending[joinedId];
                saveData();
            }
        }
    }, 60000);
});

// --- INVITE TRACKING ---
client.on('inviteCreate', invite => {
    const guildInvites = invitesCache.get(invite.guild.id);
    if (guildInvites) guildInvites.set(invite.code, invite.uses);
});

client.on('inviteDelete', invite => {
    const guildInvites = invitesCache.get(invite.guild.id);
    if (guildInvites) guildInvites.delete(invite.code);
});

client.on('guildMemberAdd', async member => {
    if (member.guild.id !== TARGET_GUILD) return;

    const cachedInvites = invitesCache.get(member.guild.id) || new Map();
    const newInvites = await member.guild.invites.fetch();
    
    let usedInvite;
    newInvites.each(inv => {
        const oldUses = cachedInvites.get(inv.code);
        if (inv.uses > oldUses) usedInvite = inv;
    });
    
    invitesCache.set(member.guild.id, new Map(newInvites.map(inv => [inv.code, inv.uses])));

    if (usedInvite && usedInvite.inviter) {
        const inviterId = usedInvite.inviter.id;
        const joinedId = member.id;
        
        const inviterData = getUser(inviterId);
        
        // Anti-spam checks
        const spamKey = `${inviterId}_${joinedId}`;
        db.spamTrack[spamKey] = (db.spamTrack[spamKey] || 0) + 1;

        if (db.spamTrack[spamKey] >= 3) {
            inviterData.blacklisted = true;
            getUser(joinedId).blacklisted = true;
            saveData();
            
            try {
                const embed = new EmbedBuilder()
                    .setTitle('⛔ Blacklisted')
                    .setDescription('You have been blacklisted from the invite system due to invite spamming/farming.')
                    .setColor('#ff0000');
                await usedInvite.inviter.send({ embeds: [embed] });
                await member.send({ embeds: [embed] });
            } catch (e) { /* ignore dm errors */ }
            return;
        }

        if (inviterData.blacklisted) return; // Ignore if blacklisted

        // Check if invited before
        if (!db.history[joinedId]) db.history[joinedId] = [];
        
        if (!db.history[joinedId].includes(inviterId)) {
            // Valid new invite
            db.history[joinedId].push(inviterId);
            inviterData.invites += 1;
            
            // Add to pending for 1-hour point
            db.pending[joinedId] = { inviter: inviterId, time: Date.now() };
            saveData();
        }
    }
});

client.on('guildMemberRemove', member => {
    if (member.guild.id !== TARGET_GUILD) return;
    // If they leave before 1 hour, remove from pending points
    if (db.pending[member.id]) {
        delete db.pending[member.id];
        saveData();
    }
});

// --- COMMANDS ---
client.on('messageCreate', async message => {
    if (message.author.bot || !message.guild) return;
    if (message.guild.id !== TARGET_GUILD) return;
    if (!message.content.startsWith('!')) return;

    const isOwner = message.author.username === OWNER_USERNAME || message.author.globalName === OWNER_USERNAME;
    
    // Check channel permission
    if (!isOwner && message.channel.id !== COMMAND_CHANNEL) return;

    const args = message.content.slice(1).trim().split(/ +/);
    const fullCmd = args.join(' ').toLowerCase();
    
    const targetUser = message.mentions.users.first();
    const amountArgs = args.filter(a => !isNaN(a));
    const amount = amountArgs.length > 0 ? parseInt(amountArgs[0]) : 1;

    // Helper function for sending embed panels
    const sendPanel = (title, desc, color = '#2f3136') => {
        const embed = new EmbedBuilder().setTitle(title).setDescription(desc).setColor(color);
        return message.reply({ embeds: [embed] });
    };

    // --- OWNER COMMANDS ---
    if (isOwner) {
        if (fullCmd.startsWith('clear invites')) {
            if (targetUser) {
                getUser(targetUser.id).invites = 0;
                sendPanel('✅ Success', `Cleared invites for <@${targetUser.id}>.`, '#00ff00');
            } else {
                for (let id in db.users) db.users[id].invites = 0;
                sendPanel('✅ Success', `Cleared invites for **everyone**.`, '#00ff00');
            }
            saveData();
            return;
        }

        if (fullCmd.startsWith('add invites')) {
            if (targetUser) {
                getUser(targetUser.id).invites += amount;
                sendPanel('✅ Success', `Added **${amount}** invites to <@${targetUser.id}>.`, '#00ff00');
            } else {
                for (let id in db.users) db.users[id].invites += amount;
                sendPanel('✅ Success', `Added **${amount}** invites to **everyone**.`, '#00ff00');
            }
            saveData();
            return;
        }

        if (fullCmd.startsWith('deduce invites')) {
            if (targetUser) {
                getUser(targetUser.id).invites = Math.max(0, getUser(targetUser.id).invites - amount);
                sendPanel('✅ Success', `Deducted **${amount}** invites from <@${targetUser.id}>.`, '#00ff00');
            } else {
                for (let id in db.users) db.users[id].invites = Math.max(0, db.users[id].invites - amount);
                sendPanel('✅ Success', `Deducted **${amount}** invites from **everyone**.`, '#00ff00');
            }
            saveData();
            return;
        }

        if (fullCmd.startsWith('blacklist') && targetUser) {
            getUser(targetUser.id).blacklisted = true;
            saveData();
            sendPanel('⛔ Blacklisted', `<@${targetUser.id}> has been blacklisted.`, '#ff0000');
            try {
                await targetUser.send({ embeds: [new EmbedBuilder().setTitle('⛔ Blacklisted').setDescription('You have been blacklisted from the invite system.').setColor('#ff0000')] });
            } catch(e) {}
            return;
        }

        if (fullCmd.startsWith('whitelist') && targetUser) {
            getUser(targetUser.id).blacklisted = false;
            saveData();
            sendPanel('✅ Whitelisted', `<@${targetUser.id}> has been whitelisted.`, '#00ff00');
            return;
        }

        if (fullCmd === 'statue') {
            const embed = new EmbedBuilder()
                .setTitle('📊 Server Statistics')
                .setDescription('Select a button below to view the respective boards.')
                .setColor('#5865F2');

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('lb_points').setLabel('Points Leaderboard').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('lb_invites').setLabel('Invites Leaderboard').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('lb_blacklist').setLabel('Blacklist').setStyle(ButtonStyle.Danger)
            );

            return message.reply({ embeds: [embed], components: [row] });
        }
    }

    // --- MEMBER COMMANDS ---
    if (fullCmd.startsWith('check invites')) {
        const target = targetUser || message.author;
        const data = getUser(target.id);
        if (data.blacklisted) return sendPanel('⛔ Error', 'This user is blacklisted.', '#ff0000');
        return sendPanel('📨 Invites', `<@${target.id}> currently has **${data.invites}** valid invites.`, '#5865F2');
    }

    if (fullCmd.startsWith('check points')) {
        const target = targetUser || message.author;
        const data = getUser(target.id);
        if (data.blacklisted) return sendPanel('⛔ Error', 'This user is blacklisted.', '#ff0000');
        return sendPanel('⭐ Points', `<@${target.id}> currently has **${data.points}** points.`, '#FFD700');
    }

    if (fullCmd === 'perks') {
        const perkEmbed = new EmbedBuilder()
            .setTitle('🎁 **Fire Lab — Invite Rewards** 🎁')
            .setDescription(`━━━━━━━━━━━━━━━━━━━\n\nWe’re excited to introduce our **Invite Reward Program**!\nBring new members into Fire Lab and unlock exclusive perks:\n\n⬡ **Invite 1 person who buys** → Earn **10%** of the worth of their purchase.\n⬡ **Invite 5 people** → Get **48h Premium** for **one script of your choice** OR **any shop item for 24h**.\n⬡ **Invite 10 people** → Get **48h Premium** for **all scripts** OR **any shop item for 48h**.\n⬡ **Invite 15 people** → Choose between:\n   ✦ **2 items from the shop**\n   ✦ **Premium for 1 script (7 days)**\n   ✦ **Premium for all scripts (4 days)**\n\n━━━━━━━━━━━━━━━━━━━\n⚡ **Testing The Limits — Fire Lab** ⚡\n━━━━━━━━━━━━━━━━━━━\n@everyone`)
            .setColor('#ff4500');

        try {
            await message.author.send({ embeds: [perkEmbed] });
            return sendPanel('📬 Sent', 'The perks list has been sent to your DMs!', '#00ff00');
        } catch (err) {
            return sendPanel('❌ Error', 'I could not send you a DM. Please check your privacy settings.', '#ff0000');
        }
    }
});

// --- BUTTON INTERACTIONS (STATUE PANEL) ---
client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;

    if (interaction.customId === 'lb_points') {
        const sorted = Object.entries(db.users)
            .filter(([_, data]) => !data.blacklisted && data.points > 0)
            .sort((a, b) => b[1].points - a[1].points)
            .slice(0, 10);
            
        let desc = sorted.map((u, i) => `**${i + 1}.** <@${u[0]}> - ${u[1].points} Points`).join('\n') || 'No points yet.';
        const embed = new EmbedBuilder().setTitle('⭐ Points Leaderboard').setDescription(desc).setColor('#FFD700');
        await interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (interaction.customId === 'lb_invites') {
        const sorted = Object.entries(db.users)
            .filter(([_, data]) => !data.blacklisted && data.invites > 0)
            .sort((a, b) => b[1].invites - a[1].invites)
            .slice(0, 10);
            
        let desc = sorted.map((u, i) => `**${i + 1}.** <@${u[0]}> - ${u[1].invites} Invites`).join('\n') || 'No invites yet.';
        const embed = new EmbedBuilder().setTitle('📨 Invites Leaderboard').setDescription(desc).setColor('#5865F2');
        await interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (interaction.customId === 'lb_blacklist') {
        const blacklisted = Object.entries(db.users).filter(([_, data]) => data.blacklisted);
        let desc = blacklisted.map(u => `• <@${u[0]}>`).join('\n') || 'No one is blacklisted.';
        const embed = new EmbedBuilder().setTitle('⛔ Blacklisted Users').setDescription(desc).setColor('#ff0000');
        await interaction.reply({ embeds: [embed], ephemeral: true });
    }
});

client.login(TOKEN);
