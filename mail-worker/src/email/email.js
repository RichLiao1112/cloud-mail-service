import PostalMime from 'postal-mime';
import emailService from '../service/email-service';
import accountService from '../service/account-service';
import settingService from '../service/setting-service';
import attService from '../service/att-service';
import constant from '../const/constant';
import fileUtils from '../utils/file-utils';
import { emailConst, isDel, settingConst } from '../const/entity-const';
import emailUtils from '../utils/email-utils';
import roleService from '../service/role-service';
import userService from '../service/user-service';
import telegramService from '../service/telegram-service';
import aiService from '../service/ai-service';
import webhookService from '../service/webhook-service';

export async function email(message, env, ctx) {

	try {

		const {
			receive,
			tgChatId,
			tgBotStatus,
			forwardStatus,
			forwardEmail,
			webhookStatus,
			webhookUrl,
			webhookRetry,
			webhookSecret,
			ruleEmail,
			ruleType,
			r2Domain,
			noRecipient,
			blackSubject,
			blackContent,
			blackFrom,
			aiCode,
			aiCodeFilter
		} = await settingService.query({ env });

		if (receive === settingConst.receive.CLOSE) {
			message.setReject('Service suspended');
			return;
		}

		const reader = message.raw.getReader();
		let content = '';

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			content += new TextDecoder().decode(value);
		}

		const email = await PostalMime.parse(content);


		const blockFlag = checkBlock(blackSubject, blackContent, blackFrom, email);

		if (blockFlag) {
			message.setReject('Message rejected');
			return;
		}

		let account = await accountService.selectByEmailIncludeDel({ env: env }, message.to);

		if (!account) {
			const baseEmail = emailUtils.getBaseEmail(message.to);
			if (baseEmail && baseEmail !== message.to) {
				account = await accountService.selectByEmailIncludeDel({ env: env }, baseEmail);
			}
		}

		if (!account && noRecipient === settingConst.noRecipient.CLOSE) {
			message.setReject('Recipient not found');
			return;
		}

		let userRow = {}

		if (account) {
			 userRow = await userService.selectByIdIncludeDel({ env: env }, account.userId);
		}

		if (account && userRow.email !== env.admin) {

			let { banEmail, availDomain } = await roleService.selectByUserId({ env: env }, account.userId);

			if (!roleService.hasAvailDomainPerm(availDomain, message.to)) {
				message.setReject('The recipient is not authorized to use this domain.');
				return;
			}

			if(roleService.isBanEmail(banEmail, email.from.address)) {
				message.setReject('The recipient is disabled from receiving emails.');
				return;
			}

		}


		if (!email.to) {
			email.to = [{ address: message.to, name: emailUtils.getName(message.to)}]
		}

		const toName = email.to.find(item => item.address === message.to)?.name || '';
		const code = await aiService.extractCode({ env }, email, { aiCode, aiCodeFilter });

		const params = {
			toEmail: message.to,
			toName: toName,
			sendEmail: email.from.address,
			name: email.from.name || emailUtils.getName(email.from.address),
			subject: email.subject,
			code,
			content: email.html,
			text: email.text,
			cc: email.cc ? JSON.stringify(email.cc) : '[]',
			bcc: email.bcc ? JSON.stringify(email.bcc) : '[]',
			recipient: JSON.stringify(email.to),
			inReplyTo: email.inReplyTo,
			relation: email.references,
			messageId: email.messageId,
			userId: account ? account.userId : 0,
			accountId: account ? account.accountId : 0,
			isDel: isDel.DELETE,
			status: emailConst.status.SAVING
		};

		const attachments = [];
		const cidAttachments = [];

		for (let item of email.attachments) {
			let attachment = { ...item };
			attachment.key = constant.ATTACHMENT_PREFIX + await fileUtils.getBuffHash(attachment.content) + fileUtils.getExtFileName(item.filename);
			attachment.size = item.content.length ?? item.content.byteLength;
			attachments.push(attachment);
			if (attachment.contentId) {
				cidAttachments.push(attachment);
			}
		}

		let emailRow = await emailService.receive({ env }, params, cidAttachments, r2Domain);

		attachments.forEach(attachment => {
			attachment.emailId = emailRow.emailId;
			attachment.userId = emailRow.userId;
			attachment.accountId = emailRow.accountId;
		});

		try {
			if (attachments.length > 0) {
				await attService.addAtt({ env }, attachments);
			}
		} catch (e) {
			console.error(e);
		}

		emailRow = await emailService.completeReceive({ env }, account ? emailConst.status.RECEIVE : emailConst.status.NOONE, emailRow.emailId);


		if (ruleType === settingConst.ruleType.RULE) {

			const emails = ruleEmail.split(',');

			if (!emails.includes(message.to)) {
				return;
			}

		}

		//转发到TG
		if (tgBotStatus === settingConst.tgBotStatus.OPEN && tgChatId) {
			await telegramService.sendEmailToBot({ env }, emailRow)
		}

		//转发到其他邮箱
		if (forwardStatus === settingConst.forwardStatus.OPEN && forwardEmail) {

			const emails = forwardEmail.split(',');

			await Promise.all(emails.map(async email => {

				try {
					await message.forward(email);
				} catch (e) {
					console.error(`转发邮箱 ${email} 失败：`, e);
				}

			}));

		}

		//转发到 Webhook
		if (webhookStatus === settingConst.webhookStatus.OPEN && webhookUrl) {
			await webhookService.sendEmail({ env }, emailRow, webhookUrl, webhookRetry, webhookSecret);
		}

		//转发到钉钉机器人
		try {
			await sendToDingTalkIfMatched(env, emailRow);
		} catch (dtErr) {
			console.error('推送钉钉异常:', dtErr);
		}

	} catch (e) {
		console.error('邮件接收异常: ', e);
		throw e
	}
}

async function sendToDingTalkIfMatched(env, emailRow) {
	const webhookUrl = env.dingtalk_webhook_url;
	if (!webhookUrl) return;

	const targetEmail = (env.dingtalk_target_email || 'x-report@liveppp.com').toLowerCase();
	const toEmail = String(emailRow.toEmail || '').toLowerCase();
	if (targetEmail && !toEmail.includes(targetEmail)) {
		return;
	}

	const rawKeywords = env.dingtalk_keywords || 'X晨报,x-report,晨报,精报,推特';
	const keywords = rawKeywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
	const subject = String(emailRow.subject || '');
	const subjectLower = subject.toLowerCase();

	const matched = keywords.length === 0 || keywords.some(k => subjectLower.includes(k));
	if (!matched) {
		console.log(`[DingTalk] 邮件主题 "${subject}" 未匹配关键词，跳过推送`);
		return;
	}

	let content = emailRow.text || '';
	if (!content && emailRow.content) {
		content = emailRow.content.replace(/<style[\s\S]*?<\/style>/gi, '')
								  .replace(/<script[\s\S]*?<\/script>/gi, '')
								  .replace(/<[^>]+>/g, ' ')
								  .replace(/\s+/g, ' ')
								  .trim();
	}

	if (content) {
		// 统一换行符
		content = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

		// 还原正文中所有 Google 重定向包装的链接 (google.com/url?q=...)
		content = content.replace(/https?:\/\/(?:www\.)?google\.[a-z.]+\/url\?[^\s\)\"\'<>]+/gi, (m) => {
			try {
				const u = new URL(m);
				return u.searchParams.get('q') || u.searchParams.get('url') || m;
			} catch (e) {
				return m;
			}
		});

		// 修复邮件客户端将 Markdown 链接折行/多余空格的问题
		content = content.replace(/\[([^\]]+)\]\(\s*([\s\S]*?)\s*\)/g, (match, linkText, url) => {
			let cleanUrl = url.replace(/\s+/g, '');
			try {
				const u = new URL(cleanUrl);
				if (u.hostname.includes('google.') && (u.searchParams.has('q') || u.searchParams.has('url'))) {
					cleanUrl = u.searchParams.get('q') || u.searchParams.get('url');
				}
			} catch (e) {}
			return `[${linkText.trim()}](${cleanUrl})`;
		});
	}

	if (content.length > 5000) {
		content = content.slice(0, 5000) + '\n\n> *(提示：邮件过长，已截取前 5000 字展示)*';
	}

	// 识别正文中的 TTS 音频直链（tts.xinyuliao.com 或 .mp3 音频），在顶部加入醒目的音频收听按钮
	const ttsMatch = content.match(/https?:\/\/tts\.[^\s\)\"\'<>]+/i) || content.match(/https?:\/\/[^\s\)\"\'<>]+?\.mp3(?:\?[^\s\)\"\'<>]+)?/i);
	let headerBanner = '';
	if (ttsMatch) {
		headerBanner = `> 🎙️ **语音播报**：[点击直接播放音频](${ttsMatch[0]})\n\n---\n\n`;
		// 从正文中移除原本的收听语音版链接文案，避免重复显示
		content = content.replace(/\[[^\]]*?(?:收听|语音|音频)[^\]]*?\]\([^\)]+\)/gi, '');
		// 清理标题行后残留的多余空白
		content = content.replace(/(#{1,6}[^\n]+?)[ \t]+(?=\n|$)/g, '$1');
	}

	const markdownText = headerBanner + (content ? content : `### ${subject}\n\n*(无正文)*`);

	let finalUrl = webhookUrl;
	if (env.dingtalk_secret) {
		const timestamp = Date.now();
		const stringToSign = `${timestamp}\n${env.dingtalk_secret}`;
		const key = await crypto.subtle.importKey(
			'raw',
			new TextEncoder().encode(env.dingtalk_secret),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign']
		);
		const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(stringToSign));
		const signBase64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
		const sep = finalUrl.includes('?') ? '&' : '?';
		finalUrl = `${finalUrl}${sep}timestamp=${timestamp}&sign=${encodeURIComponent(signBase64)}`;
	}

	const res = await fetch(finalUrl, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			msgtype: 'markdown',
			markdown: {
				title: `📧 ${subject}`,
				text: markdownText,
			},
		}),
	});

	const result = await res.json().catch(() => ({}));
	console.log('[DingTalk] 推送结果:', JSON.stringify(result));
}

function checkBlock(blackSubjectStr, blackContentStr, blackFromStr, email) {

	const blackFromList = blackFromStr ? blackFromStr.split(',') : []
	const blackContentList = blackContentStr ? blackContentStr.split(',') : []
	const blackSubjectList = blackSubjectStr ? blackSubjectStr.split(',') : []

	for (const blackSubject of blackSubjectList) {
		if (email.subject?.includes(blackSubject)) {
			return true
		}
	}

	for (const blackContent of blackContentList) {
		if (email.html?.includes(blackContent) || email.text?.includes(blackContent)) {
			return true
		}
	}

	for (const blackFrom of blackFromList) {
		if (email.from.address === blackFrom || emailUtils.getDomain(email.from.address) === blackFrom) {
			return true
		}
	}

	return false

}

