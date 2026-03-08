import { Notice, requestUrl, RequestUrlParam, Platform } from 'obsidian';
import { settingsStore } from './settings';
import { get } from 'svelte/store';
import { getCookieString } from './utils/cookiesUtil';
import { Cookie, parse, splitCookiesString } from 'set-cookie-parser';
import {
	HighlightResponse,
	BookReviewResponse,
	ChapterResponse,
	BookReadInfoResponse,
	BookDetailResponse,
	BookProgressResponse
} from './models';
import CookieCloudManager from './cookieCloud';

type RequestOptions<T> = {
	action: string;
	errorNotice?: string;
	fallback: T;
	clearCookiesOnAuthFailure?: boolean;
	authFailureNotice?: {
		desktop: string;
		mobile: string;
	};
	retryOnTimeout?: boolean;
};

export default class ApiManager {
	readonly baseUrl: string = 'https://weread.qq.com';

	private getHeaders() {
		return {
			'User-Agent':
				'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/73.0.3683.103 Safari/537.36',
			'Accept-Encoding': 'gzip, deflate, br',
			'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
			accept: 'application/json, text/plain, */*',
			'Content-Type': 'application/json',
			Cookie: getCookieString(get(settingsStore).cookies)
		};
	}

	private getResponseCookie(headers: Record<string, string>): string | undefined {
		return headers['set-cookie'] || headers['Set-Cookie'];
	}

	private isLoginTimeoutError(respJson: any): boolean {
		if (!respJson || typeof respJson !== 'object') {
			return false;
		}
		return respJson.errcode === -2012 || respJson.errCode === -2012;
	}

	private async requestJson<T>(
		req: RequestUrlParam,
		options: RequestOptions<T>,
		allowRetry = true
	): Promise<T> {
		try {
			const resp = await requestUrl(req);
			const respJson = resp.json;

			// CookieCloud 的 cookie 可能缺少关键字段，这里统一尝试用 set-cookie 补齐。
			const respCookie = this.getResponseCookie(resp.headers);
			if (respCookie !== undefined) {
				this.updateCookies(respCookie);
			}

			if (this.isLoginTimeoutError(respJson)) {
				console.log('weread cookie expire retry refresh cookie... ');
				if (options.retryOnTimeout !== false && allowRetry) {
					await this.refreshCookie();
					return this.requestJson(req, options, false);
				}
			}

			if (resp.status === 401) {
				if (options.authFailureNotice) {
					new Notice(
						Platform.isDesktopApp
							? options.authFailureNotice.desktop
							: options.authFailureNotice.mobile
					);
				}
				if (options.clearCookiesOnAuthFailure) {
					settingsStore.actions.clearCookies();
				}
				console.log(`[weread plugin] ${options.action} unauthorized`, respJson);
				return options.fallback;
			}

			return respJson as T;
		} catch (e: any) {
			if (e?.status === 401 && allowRetry) {
				console.log(`parse request to cURL for debug: ${this.parseToCurl(req)}`);
				await this.refreshCookie();
				return this.requestJson(req, options, false);
			}

			if (options.errorNotice) {
				new Notice(options.errorNotice);
			}
			console.error(`[weread plugin] ${options.action} error`, e);
			return options.fallback;
		}
	}

	async refreshCookie() {
		const req: RequestUrlParam = {
			url: this.baseUrl,
			method: 'HEAD',
			headers: this.getHeaders()
		};
		const resp = await requestUrl(req);
		const respCookie: string = resp.headers['set-cookie'] || resp.headers['Set-Cookie'];

		if (respCookie !== undefined && this.checkCookies(respCookie)) {
			new Notice('cookie已过期，尝试刷新Cookie成功');
			this.updateCookies(respCookie);
		} else {
			const loginMethod = get(settingsStore).loginMethod;
			if (loginMethod === 'cookieCloud') {
				const cookieCloudManager = new CookieCloudManager();
				const isSuccess = await cookieCloudManager.getCookie();
				if (!isSuccess) {
					new Notice('尝试刷新Cookie失败');
				}
			} else {
				new Notice('尝试刷新Cookie失败');
			}
		}
	}

	async getNotebooksWithRetry() {
		let noteBookResp: [] = await this.getNotebooks();
		if (noteBookResp === undefined || noteBookResp.length === 0) {
			//retry get notebooks
			noteBookResp = await this.getNotebooks();
		}
		if (noteBookResp === undefined || noteBookResp.length === 0) {
			new Notice('长时间未登录，Cookie已失效，请重新扫码登录！');
			settingsStore.actions.clearCookies();
			throw Error('get weread note book error after retry');
		}
		return noteBookResp;
	}

	async getNotebooks() {
		const req: RequestUrlParam = {
			url: `${this.baseUrl}/api/user/notebook`,
			method: 'GET',
			headers: this.getHeaders()
		};

		const resp = await this.requestJson<{ books?: [] }>(req, {
			action: 'get notebooks',
			fallback: { books: [] },
			clearCookiesOnAuthFailure: true,
			authFailureNotice: {
				desktop: '微信读书未登录或者用户异常，请在设置中重新登录！',
				mobile: '微信读书未登录或者用户异常，请在电脑端重新登录！'
			}
		});

		return resp.books || [];
	}

	private parseToCurl(req: RequestUrlParam) {
		const command = ['curl'];
		command.push(req.url);
		const requestHeaders = req.headers;
		Object.keys(requestHeaders).forEach((name) => {
			command.push('-H');
			command.push(
				this.escapeStringPosix(name.replace(/^:/, '') + ': ' + requestHeaders[name])
			);
		});
		command.push('  --compressed');
		return command.join(' ');
	}

	private escapeStringPosix(str: string) {
		function escapeCharacter(x) {
			let code = x.charCodeAt(0);
			if (code < 256) {
				// Add leading zero when needed to not care about the next character.
				return code < 16 ? '\\x0' + code.toString(16) : '\\x' + code.toString(16);
			}
			code = code.toString(16);
			return '\\u' + ('0000' + code).substr(code.length, 4);
		}

		if (/[^\x20-\x7E]|'/.test(str)) {
			// Use ANSI-C quoting syntax.
			return (
				"$'" +
				str
					.replace(/\\/g, '\\\\')
					.replace(/'/g, "\\'")
					.replace(/\n/g, '\\n')
					.replace(/\r/g, '\\r')
					.replace(/[^\x20-\x7E]/g, escapeCharacter) +
				"'"
			);
		} else {
			// Use single quote syntax.
			return "'" + str + "'";
		}
	}

	async getBook(bookId: string): Promise<BookDetailResponse> {
		const req: RequestUrlParam = {
			url: `${this.baseUrl}/web/book/info?bookId=${bookId}`,
			method: 'GET',
			headers: this.getHeaders()
		};
		return this.requestJson<BookDetailResponse>(req, {
			action: `get book detail ${bookId}`,
			fallback: null,
			errorNotice: '获取书籍详情失败，请检查您的 Cookies 并重试。'
		});
	}

	async getNotebookHighlights(bookId: string): Promise<HighlightResponse> {
		const req: RequestUrlParam = {
			url: `${this.baseUrl}/web/book/bookmarklist?bookId=${bookId}`,
			method: 'GET',
			headers: this.getHeaders()
		};
		return this.requestJson<HighlightResponse>(req, {
			action: `get book highlights ${bookId}`,
			fallback: { updated: [], chapters: [] } as HighlightResponse,
			errorNotice: '获取划线数据失败，请检查您的 Cookies 并重试。'
		});
	}

	async getNotebookReviews(bookId: string): Promise<BookReviewResponse> {
		const url = `${this.baseUrl}/web/review/list?bookId=${bookId}&listType=11&mine=1&synckey=0`;
		const req: RequestUrlParam = { url: url, method: 'GET', headers: this.getHeaders() };
		return this.requestJson<BookReviewResponse>(req, {
			action: `get notebook reviews ${bookId}`,
			fallback: { reviews: [] } as BookReviewResponse,
			errorNotice:
				'Failed to fetch weread notebook reviews . Please check your Cookies and try again.'
		});
	}

	async getChapters(bookId: string): Promise<ChapterResponse> {
		const url = `${this.baseUrl}/web/book/chapterInfos`;
		const reqBody = {
			bookIds: [bookId]
		};

		const req: RequestUrlParam = {
			url: url,
			method: 'POST',
			headers: this.getHeaders(),
			body: JSON.stringify(reqBody)
		};

		return this.requestJson<ChapterResponse>(req, {
			action: `get chapters ${bookId}`,
			fallback: { data: [] } as ChapterResponse,
			errorNotice:
				'Failed to fetch weread notebook chapters . Please check your Cookies and try again.'
		});
	}
	/**
	 * 获取书籍阅读进度信息
	 * @param bookId 书籍ID
	 * @returns 书籍阅读进度信息
	 */
	async getProgress(bookId: string): Promise<BookProgressResponse> {
		const url = `${this.baseUrl}/web/book/getProgress?bookId=${bookId}`;
		const req: RequestUrlParam = { url: url, method: 'GET', headers: this.getHeaders() };
		return this.requestJson<BookProgressResponse>(req, {
			action: `get progress ${bookId}`,
			fallback: {} as BookProgressResponse,
			errorNotice: '获取微信读书阅读进度信息失败，请检查您的 Cookies 并重试。'
		});
	}

	/**
	 * @deprecated 该方法新 API 中已废弃，请使用 getProgress 方法代替
	 */
	async getBookReadInfo(bookId: string): Promise<BookReadInfoResponse> {
		const url = `${this.baseUrl}/web/book/readinfo?bookId=${bookId}&readingDetail=1&readingBookIndex=1&finishedDate=1`;
		const req: RequestUrlParam = { url: url, method: 'GET', headers: this.getHeaders() };
		return this.requestJson<BookReadInfoResponse>(req, {
			action: `get read info ${bookId}`,
			fallback: {} as BookReadInfoResponse,
			errorNotice:
				'Failed to fetch weread notebook read info . Please check your Cookies and try again.'
		});
	}

	private checkCookies(respCookie: string): boolean {
		let refreshCookies: Cookie[];
		if (Array.isArray(respCookie)) {
			refreshCookies = parse(respCookie);
		} else {
			const arrCookies = splitCookiesString(respCookie);
			refreshCookies = parse(arrCookies);
		}

		const wrName = refreshCookies.find((cookie) => cookie.name == 'wr_name');
		return wrName !== undefined && wrName.value !== '';
	}

	private updateCookies(respCookie: string) {
		let refreshCookies: Cookie[];
		if (Array.isArray(respCookie)) {
			refreshCookies = parse(respCookie);
		} else {
			const arrCookies = splitCookiesString(respCookie);
			refreshCookies = parse(arrCookies);
		}
		const cookies = get(settingsStore).cookies;
		cookies.forEach((cookie) => {
			const newCookie = refreshCookies.find((freshCookie) => freshCookie.name == cookie.name);
			if (newCookie) {
				cookie.value = newCookie.value;
			}
		});
		settingsStore.actions.setCookies(cookies);
	}
}
