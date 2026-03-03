const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  PermissionsBitField,
} = require("discord.js");
const dotenv = require("dotenv");

dotenv.config();

const CONFIG = {
  verifiedRoleId: process.env.VERIFIED_ROLE_ID || "1469057010069672027",
  unverifyRoleId: process.env.UNVERIFY_ROLE_ID || "1469076386538066002",
  token: process.env.BOT_TOKEN,
};

const REMOVE_TEST_COMMAND = new SlashCommandBuilder()
  .setName("remove_test")
  .setDescription("Remove o cargo unverify do usuário para teste.");

const VERIFICATION_BUTTON_ALIASES = ["verificacao", "verificar", "verify"];
const VERIFICATION_CONTENT_HINTS = ["verificacao", "verify"];
const ENCODED_CUSTOM_ID_PATTERN = /^[A-Za-z0-9+/_=-]{20,}:\d+$/;
const VERIFICATION_BUTTON_CUSTOM_IDS = new Set(
  (process.env.VERIFICATION_BUTTON_CUSTOM_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
);
const REMOVE_TEST_MESSAGE_TRIGGER = "!remove_test";
const REMOVE_RETRY_ATTEMPTS = 2;
const REMOVE_RETRY_DELAY_MS = 300;

if (!CONFIG.token) {
  console.error("[ERRO] BOT_TOKEN não está definido no .env");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeCustomId(customId) {
  if (typeof customId !== "string") return "";
  return customId
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function extractInteractionMessageText(interaction) {
  if (!interaction?.message) return "";

  const embedTexts = (interaction.message.embeds || []).flatMap((embed) => [
    embed.title,
    embed.description,
    embed.footer?.text,
    ...((embed.fields || []).flatMap((field) => [field.name, field.value])),
  ]);

  return [interaction.message.content, ...embedTexts]
    .filter(Boolean)
    .join(" ");
}

function messageLooksLikeVerification(interaction) {
  const normalizedMessageText = normalizeCustomId(
    extractInteractionMessageText(interaction),
  );
  if (!normalizedMessageText) return false;

  return VERIFICATION_CONTENT_HINTS.some((hint) =>
    normalizedMessageText.includes(hint),
  );
}

function isVerificationButton(interaction) {
  const customId = interaction?.customId;
  if (!customId) return false;

  if (VERIFICATION_BUTTON_CUSTOM_IDS.has(customId)) {
    return true;
  }

  const normalizedId = normalizeCustomId(customId);
  if (!normalizedId) return false;

  const aliasMatch = VERIFICATION_BUTTON_ALIASES.some(
    (alias) => normalizedId === alias || normalizedId.includes(alias),
  );
  if (aliasMatch) return true;

  // Alguns builders externos geram customIds assinados (base64-like + ":index").
  return (
    ENCODED_CUSTOM_ID_PATTERN.test(customId) &&
    messageLooksLikeVerification(interaction)
  );
}

function stripEphemeral(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const { ephemeral, ...rest } = payload;
  return rest;
}

async function safeInteractionReply(interaction, payload) {
  try {
    if (interaction.deferred || interaction.replied) {
      return await interaction.editReply(stripEphemeral(payload));
    }
    return await interaction.reply(payload);
  } catch (error) {
    console.error("[ERRO] Falha ao responder interação:", error);
    return null;
  }
}

function getPermissionErrorMessage(error, fallbackMessage) {
  if (error?.code === 50013) {
    return "❌ Sem permissão para gerenciar cargos. Coloque o cargo do bot acima dos cargos-alvo.";
  }
  return fallbackMessage;
}

async function addVerifiedWithDiagnostics(guild, member, reason) {
  const verifiedRole = await guild.roles.fetch(CONFIG.verifiedRoleId);
  if (!verifiedRole) {
    return {
      added: false,
      message:
        "Não encontrei o cargo de verificação no servidor. Confira CONFIG.verifiedRoleId.",
      role: null,
    };
  }

  if (member.roles.cache.has(verifiedRole.id)) {
    return {
      added: true,
      message: "Usuário já tinha o cargo de verificação.",
      role: verifiedRole,
    };
  }

  const botMember = await guild.members.fetchMe();
  if (!botMember.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    return {
      added: false,
      message: "O bot não tem a permissão 'Gerenciar Cargos'.",
      role: null,
    };
  }

  if (verifiedRole.managed) {
    return {
      added: false,
      message:
        "O cargo de verificação é gerenciado por integração (managed) e não pode ser adicionado manualmente.",
      role: null,
    };
  }

  if (botMember.roles.highest.position <= verifiedRole.position) {
    return {
      added: false,
      message: `Hierarquia inválida: cargo mais alto do bot (${botMember.roles.highest.position}) precisa ficar acima do verificado (${verifiedRole.position}).`,
      role: null,
    };
  }

  if (!member.manageable) {
    return {
      added: false,
      message:
        "Não consigo gerenciar esse membro (dono do servidor ou acima do bot na hierarquia).",
      role: null,
    };
  }

  try {
    await member.roles.add(verifiedRole.id, reason);
    return {
      added: true,
      message: "Cargo de verificação adicionado.",
      role: verifiedRole,
    };
  } catch (error) {
    console.error("[ERRO] Falha ao adicionar cargo de verificação:", error);
    return {
      added: false,
      message:
        error?.code === 50013
          ? "Sem permissão para adicionar o cargo de verificação (erro 50013)."
          : `Erro ao adicionar cargo de verificação (code: ${error?.code ?? "desconhecido"}).`,
      role: null,
    };
  }
}

async function removeUnverifyWithDiagnostics(guild, member, reason) {
  const roleUnverify = await guild.roles.fetch(CONFIG.unverifyRoleId);
  if (!roleUnverify) {
    return {
      removed: false,
      message:
        "Não encontrei o cargo unverify no servidor. Confira CONFIG.unverifyRoleId.",
    };
  }

  if (!member.roles.cache.has(roleUnverify.id)) {
    return { removed: true, message: "Usuário já estava sem unverify." };
  }

  const botMember = await guild.members.fetchMe();
  if (!botMember.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    return {
      removed: false,
      message: "O bot não tem a permissão 'Gerenciar Cargos'.",
    };
  }

  if (roleUnverify.managed) {
    return {
      removed: false,
      message:
        "O cargo unverify é gerenciado por integração (managed) e não pode ser removido manualmente.",
    };
  }

  if (botMember.roles.highest.position <= roleUnverify.position) {
    return {
      removed: false,
      message: `Hierarquia inválida: cargo mais alto do bot (${botMember.roles.highest.position}) precisa ficar acima do unverify (${roleUnverify.position}).`,
    };
  }

  if (!member.manageable) {
    return {
      removed: false,
      message:
        "Não consigo gerenciar esse membro (dono do servidor ou acima do bot na hierarquia).",
    };
  }

  try {
    await member.roles.remove(roleUnverify.id, reason);

    // Retry curto para cobrir re-add imediato por outra automação.
    for (let i = 0; i < REMOVE_RETRY_ATTEMPTS; i += 1) {
      await wait(REMOVE_RETRY_DELAY_MS);
      const refreshedMember = await guild.members.fetch(member.id);

      if (!refreshedMember.roles.cache.has(roleUnverify.id)) {
        return { removed: true, message: "Cargo unverify removido." };
      }

      await refreshedMember.roles
        .remove(roleUnverify.id, `${reason} (retry ${i + 1})`)
        .catch(() => {});
    }

    const finalMember = await guild.members.fetch(member.id);
    if (finalMember.roles.cache.has(roleUnverify.id)) {
      return {
        removed: false,
        message:
          "Outro bot/sistema está recolocando o unverify ou ainda há bloqueio de hierarquia.",
      };
    }

    return { removed: true, message: "Cargo unverify removido." };
  } catch (error) {
    console.error("[ERRO] Falha ao remover unverify:", error);
    return {
      removed: false,
      message:
        error?.code === 50013
          ? "Sem permissão para remover unverify (erro 50013)."
          : `Erro ao remover unverify (code: ${error?.code ?? "desconhecido"}).`,
    };
  }
}

async function verifyMemberWithDiagnostics(guild, member) {
  const verifiedResult = await addVerifiedWithDiagnostics(
    guild,
    member,
    "Verificação via botão",
  );

  if (!verifiedResult.added || !verifiedResult.role) {
    return {
      verified: false,
      message: verifiedResult.message,
      role: null,
      unverifyResult: null,
    };
  }

  const unverifyResult = await removeUnverifyWithDiagnostics(
    guild,
    member,
    "Verificação via botão",
  );

  return {
    verified: true,
    message: verifiedResult.message,
    role: verifiedResult.role,
    unverifyResult,
  };
}

async function registerRemoveTestCommand(guild) {
  try {
    const commands = await guild.commands.fetch();
    const existingCommand = commands.find(
      (command) => command.name === REMOVE_TEST_COMMAND.name,
    );

    if (existingCommand) {
      await existingCommand.edit(REMOVE_TEST_COMMAND.toJSON());
    } else {
      await guild.commands.create(REMOVE_TEST_COMMAND.toJSON());
    }

    console.log(`[LOG] /remove_test registrado em ${guild.name}`);
  } catch (error) {
    if (error?.code === 50001) {
      console.error(
        `[ERRO] Missing Access ao registrar /remove_test em ${guild.name}. Reconvide o bot com o escopo applications.commands.`,
      );
      return;
    }

    console.error(
      `[ERRO] Falha ao registrar /remove_test em ${guild.name}:`,
      error,
    );
  }
}

async function registerCommandsForAllGuilds() {
  const fetchedGuilds = await client.guilds.fetch();

  await Promise.allSettled(
    [...fetchedGuilds.keys()].map(async (guildId) => {
      const guild = await client.guilds.fetch(guildId);
      await registerRemoveTestCommand(guild);
    }),
  );
}

async function registerGlobalFallbackCommand() {
  try {
    await client.application.commands.create(REMOVE_TEST_COMMAND.toJSON());
    console.log("[LOG] /remove_test registrado globalmente (fallback).");
  } catch (error) {
    console.error("[ERRO] Falha ao registrar /remove_test global:", error);
  }
}

async function handleVerificationButton(interaction) {
  console.log(`[LOG] Botão clicado: customId="${interaction.customId}"`);

  if (!isVerificationButton(interaction)) {
    console.warn(
      `[WARN] Botão não mapeado para verificação: "${interaction.customId}"`,
    );
    await safeInteractionReply(interaction, {
      content:
        "⚠️ Este botão não estava mapeado para verificação. Tente novamente ou chame um admin.",
      ephemeral: true,
    });
    return;
  }

  if (!interaction.inGuild()) {
    await safeInteractionReply(interaction, {
      content: "❌ Esse botão só funciona dentro de um servidor.",
      ephemeral: true,
    });
    return;
  }

  try {
    await interaction.deferReply({ ephemeral: true });

    const member = await interaction.guild.members.fetch(interaction.user.id);
    const verificationResult = await verifyMemberWithDiagnostics(
      interaction.guild,
      member,
    );

    if (!verificationResult.verified || !verificationResult.role) {
      await safeInteractionReply(interaction, {
        content: `❌ ${verificationResult.message}`,
      });
      return;
    }

    const unverifyWarning = verificationResult.unverifyResult?.removed
      ? ""
      : `\n⚠️ ${verificationResult.unverifyResult?.message}`;

    await safeInteractionReply(interaction, {
      content: `✅ Verificação concluída! Você agora tem o cargo **${verificationResult.role.name}**.${unverifyWarning}`,
    });

    console.log(`[LOG] ${member.user.tag} se verificou via botão.`);
  } catch (error) {
    console.error("[ERRO] Falha ao processar verificação:", error);

    await safeInteractionReply(interaction, {
      content: getPermissionErrorMessage(
        error,
        "❌ Ocorreu um erro interno ao tentar te verificar.",
      ),
      ephemeral: true,
    });
  }
}

async function runRemoveTest(guild, userId, reason) {
  const member = await guild.members.fetch(userId);
  return removeUnverifyWithDiagnostics(guild, member, reason);
}

async function handleRemoveTestSlashCommand(interaction) {
  if (!interaction.inGuild()) {
    await safeInteractionReply(interaction, {
      content: "❌ Esse comando só funciona dentro de um servidor.",
      ephemeral: true,
    });
    return;
  }

  try {
    await interaction.deferReply({ ephemeral: true });

    const removalResult = await runRemoveTest(
      interaction.guild,
      interaction.user.id,
      "Teste via /remove_test",
    );

    if (!removalResult.removed) {
      await safeInteractionReply(interaction, {
        content: `❌ ${removalResult.message}`,
      });
      return;
    }

    await safeInteractionReply(interaction, {
      content: "✅ Cargo unverify removido com sucesso.",
    });
  } catch (error) {
    console.error("[ERRO] Falha no /remove_test:", error);

    await safeInteractionReply(interaction, {
      content: getPermissionErrorMessage(
        error,
        "❌ Ocorreu um erro ao executar /remove_test.",
      ),
      ephemeral: true,
    });
  }
}

async function handleInteractionCreate(interaction) {
  if (interaction.isButton()) {
    await handleVerificationButton(interaction);
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === REMOVE_TEST_COMMAND.name) {
    await handleRemoveTestSlashCommand(interaction);
  }
}

async function handleRemoveTestMessage(message) {
  if (message.author.bot) return;
  if (!message.guild) return;
  if (message.content.trim().toLowerCase() !== REMOVE_TEST_MESSAGE_TRIGGER) return;

  try {
    const removalResult = await runRemoveTest(
      message.guild,
      message.author.id,
      "Teste via !remove_test",
    );

    if (!removalResult.removed) {
      await message.reply(`❌ ${removalResult.message}`);
      return;
    }

    await message.reply("✅ Cargo unverify removido com sucesso.");
  } catch (error) {
    console.error("[ERRO] Falha no !remove_test:", error);
    await message.reply(
      getPermissionErrorMessage(error, "❌ Ocorreu um erro ao executar !remove_test."),
    );
  }
}

async function handleGuildMemberUpdate(oldMember, newMember) {
  const gainedVerified =
    !oldMember.roles.cache.has(CONFIG.verifiedRoleId) &&
    newMember.roles.cache.has(CONFIG.verifiedRoleId);

  const hasUnverify = newMember.roles.cache.has(CONFIG.unverifyRoleId);
  if (!gainedVerified || !hasUnverify) return;

  const unverifyRemoval = await removeUnverifyWithDiagnostics(
    newMember.guild,
    newMember,
    "Backup: ganhou verified",
  );

  if (unverifyRemoval.removed) {
    console.log(
      `[LOG] Backup: Removido unverify de ${newMember.user.tag} (ganhou verified por fora)`,
    );
    return;
  }

  console.log(
    `[WARN] Backup: não removeu unverify de ${newMember.user.tag}: ${unverifyRemoval.message}`,
  );
}

client.once("ready", async () => {
  console.log(`✅ Bot online como ${client.user.tag}`);
  console.log(`[LOG] Guilds em cache: ${client.guilds.cache.size}`);

  await registerCommandsForAllGuilds();
  await registerGlobalFallbackCommand();
});

client.on("guildCreate", async (guild) => {
  await registerRemoveTestCommand(guild);
});

client.on("interactionCreate", async (interaction) => {
  try {
    await handleInteractionCreate(interaction);
  } catch (error) {
    console.error("[ERRO] Falha em interactionCreate:", error);
  }
});

client.on("messageCreate", async (message) => {
  await handleRemoveTestMessage(message);
});

client.on("guildMemberUpdate", async (oldMember, newMember) => {
  try {
    await handleGuildMemberUpdate(oldMember, newMember);
  } catch (error) {
    console.error("[ERRO] Falha no monitoramento de cargos:", error);
  }
});

process.on("unhandledRejection", (error) => {
  console.error("[ERRO] Rejeição não tratada:", error);
});

process.on("uncaughtException", (error) => {
  console.error("[ERRO] Exceção não tratada:", error);
});

client.login(CONFIG.token);
