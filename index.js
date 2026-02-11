const { Client, GatewayIntentBits } = require('discord.js');
const dotenv = require('dotenv');
dotenv.config();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,  // ESSENCIAL!
        GatewayIntentBits.GuildMessages
    ]
});

// CONFIGURAÇÃO - EDITE AQUI!
const CONFIG = {
    verifiedRoleId: '1469057010069672027',    // ID do cargo VERIFICADO
    unverifyRoleId: '1469076386538066002',    // ID do cargo UNVERIFY
    token: process.env.BOT_TOKEN                  // Token do novo bot
};

// Evento quando o bot fica online
client.once('ready', () => {
    console.log(`✅ Bot online como ${client.user.tag}`);
    console.log(`👥 Monitorando remoção de cargo unverify`);
    console.log(`🆔 Cargo verificado: ${CONFIG.verifiedRoleId}`);
    console.log(`🗑️  Cargo a remover: ${CONFIG.unverifyRoleId}`);
});

// EVENTO PRINCIPAL: Quando um membro é atualizado
client.on('guildMemberUpdate', async (oldMember, newMember) => {
    try {
        // Verifica se ganhou o cargo de verificado
        const gainedVerified = !oldMember.roles.cache.has(CONFIG.verifiedRoleId) && 
                              newMember.roles.cache.has(CONFIG.verifiedRoleId);
        
        // Verifica se ainda tem o cargo unverify
        const hasUnverify = newMember.roles.cache.has(CONFIG.unverifyRoleId);
        
        if (gainedVerified && hasUnverify) {
            // Remove o cargo unverify
            await newMember.roles.remove(CONFIG.unverifyRoleId);
            
            console.log(`✅ Removido unverify de: ${newMember.user.tag}`);
            
            // Opcional: Log no canal
            const logChannel = newMember.guild.channels.cache.find(ch => 
                ch.name.includes('log') || ch.name.includes('registro')
            );
            
            if (logChannel) {
                await logChannel.send({
                    content: `🔄 ${newMember.user} foi verificado e teve o cargo unverify removido automaticamente.`
                });
            }
        }
    } catch (error) {
        console.error('❌ Erro:', error.message);
    }
});

// Inicia o bot
client.login(CONFIG.token);

// Tratamento de erros
process.on('unhandledRejection', error => {
    console.error('❌ Erro não tratado:', error);
});