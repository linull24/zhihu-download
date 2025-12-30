// ==UserScript==
// @name         Zhihu2Markdown
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Download Zhihu content (articles, answers, videos, columns) as Markdown
// @author       Glenn
// @match        *://zhuanlan.zhihu.com/p/*
// @match        *://www.zhihu.com/question/*/answer/*
// @match        *://www.zhihu.com/zvideo/*
// @match        *://www.zhihu.com/column/*
// @match        *://www.zhihu.com/column/*/*
// @match        *://www.zhihu.com/people/*/posts*
// @match        *://blog.csdn.net/*/article/*
// @match        *://blog.csdn.net/*/category_*.html
// @match        *://mp.weixin.qq.com/s*
// @match        *://juejin.cn/post/*
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_addStyle
// @connect      zhihu.com
// @connect      www.zhihu.com
// @connect      zhuanlan.zhihu.com
// @connect      zhimg.com
// @connect      *.zhimg.com
// @require      https://cdn.jsdelivr.net/npm/turndown@7.1.1/dist/turndown.js
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    const LOG_PREFIX = '[Zhihu2Markdown]';
    const DEBUG = (() => {
        try {
            return localStorage.getItem('Zhihu2MarkdownDebug') === '1';
        } catch (error) {
            return false;
        }
    })();

    const logInfo = (...args) => {
        if (DEBUG) console.info(LOG_PREFIX, ...args);
    };
    const logWarn = (...args) => console.warn(LOG_PREFIX, ...args);
    const logError = (...args) => console.error(LOG_PREFIX, ...args);

    logInfo('userscript loaded', { href: location.href });

    // Add CSS for UI elements
    GM_addStyle(`
        .zhihu-dl-button {
            position: fixed;
            bottom: 30px;
            right: 30px;
            z-index: 10000;
            padding: 12px 16px;
            background: #0084ff;
            color: white;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            font-size: 15px;
            font-weight: 500;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
            transition: all 0.2s ease;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .zhihu-dl-button:hover {
            background: #0077e6;
            transform: translateY(-2px);
            box-shadow: 0 6px 16px rgba(0, 0, 0, 0.25);
        }
        .zhihu-dl-button:before {
            content: "⬇️";
            margin-right: 6px;
            font-size: 16px;
        }
        .zhihu-dl-progress {
            position: fixed;
            bottom: 90px;
            right: 30px;
            z-index: 10000;
            padding: 10px 16px;
            background: white;
            border: 1px solid #eee;
            border-radius: 8px;
            font-size: 14px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
            display: none;
        }
    `);

    // Get valid filename (replace invalid characters)
    const getValidFilename = (str) => {
        return str.replace(/[\\/:*?"<>|]/g, '_').trim();
    };

    // Get article date from the page
    const getArticleDate = (selector, root = document) => {
        const dateElement = root.querySelector(selector);
        if (!dateElement) return '';

        const dateText = dateElement.textContent.trim();
        const match = dateText.match(/(\d{4}-\d{2}-\d{2})/);
        return match ? match[1] : '';
    };

    // Create a Turndown service instance for HTML to Markdown conversion
    const createTurndownService = () => {
        const service = new TurndownService({
            headingStyle: 'atx',
            codeBlockStyle: 'fenced',
            bulletListMarker: '-'
        });

        // Custom rules for Zhihu content
        // Handle math formulas
        service.addRule('mathFormulas', {
            filter: (node) => {
                return node.nodeName === 'SPAN' &&
                       node.classList.contains('ztext-math') &&
                       node.hasAttribute('data-tex');
            },
            replacement: (content, node) => {
                const formula = node.getAttribute('data-tex');
                if (formula.includes('\\tag')) {
                    return `\n$$${formula}$$\n`;
                } else {
                    return `$${formula}$`;
                }
            }
        });

        // Improve heading handling
        service.addRule('headings', {
            filter: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
            replacement: function (content, node) {
                const level = Number(node.nodeName.charAt(1));
                return `\n${'#'.repeat(level)} ${content}\n\n`;
            }
        });

        // Handle tables
        service.addRule('tables', {
            filter: ['table'],
            replacement: function(content, node) {
                // Create arrays to store each row of the table
                const rows = Array.from(node.querySelectorAll('tr'));
                if (rows.length === 0) return content;
                
                // Process each row
                const markdownRows = rows.map(row => {
                    // Get all cells in the row (th or td)
                    const cells = Array.from(row.querySelectorAll('th, td'));
                    // Convert each cell to text and trim whitespace
                    return '| ' + cells.map(cell => {
                        const cellText = cell.textContent.trim().replace(/\n/g, ' ');
                        return cellText || ' ';
                    }).join(' | ') + ' |';
                });
                
                // If the first row contains th elements, add a separator row
                if (rows[0] && rows[0].querySelector('th')) {
                    const headerCells = Array.from(rows[0].querySelectorAll('th'));
                    const separatorRow = '| ' + headerCells.map(() => '---').join(' | ') + ' |';
                    markdownRows.splice(1, 0, separatorRow);
                } else if (rows.length > 0) {
                    // If no header row but we have rows, add a separator after the first row anyway
                    const firstRowCells = Array.from(rows[0].querySelectorAll('td')).length;
                    const separatorRow = '| ' + Array(firstRowCells).fill('---').join(' | ') + ' |';
                    markdownRows.splice(1, 0, separatorRow);
                }
                
                return '\n\n' + markdownRows.join('\n') + '\n\n';
            }
        });

        return service;
    };

    // Small helper to pause between downloads
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    const normalizeUrl = (rawUrl, base = window.location.href) => {
        if (!rawUrl) return '';
        if (rawUrl.startsWith('data:')) {
            return rawUrl;
        }
        if (rawUrl.startsWith('//')) {
            return `${window.location.protocol}${rawUrl}`;
        }
        if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
            return rawUrl;
        }
        try {
            const absolute = new URL(rawUrl, base);
            return absolute.href;
        } catch (error) {
            console.warn('Failed to normalize url', rawUrl, error);
            return rawUrl;
        }
    };

    const parseIsoDate = (value) => {
        if (value === null || value === undefined || value === '') return '';

        let dateInput = value;

        if (typeof dateInput === 'string') {
            const numeric = dateInput.trim();
            if (/^\d+$/.test(numeric)) {
                dateInput = Number(numeric);
            }
        }

        if (typeof dateInput === 'number' && !Number.isNaN(dateInput)) {
            if (dateInput < 1e12) {
                dateInput *= 1000;
            }
            const date = new Date(dateInput);
            return isNaN(date.getTime()) ? '' : date.toISOString().split('T')[0];
        }

        const date = new Date(dateInput);
        return isNaN(date.getTime()) ? '' : date.toISOString().split('T')[0];
    };

    const safeParseJSON = (text) => {
        if (!text) return null;
        try {
            return JSON.parse(text);
        } catch (error) {
            logWarn('Failed to parse JSON:', error);
            return null;
        }
    };

    const detectZhihuBlockPage = (htmlText) => {
        if (!htmlText || typeof htmlText !== 'string') return '';
        if (/安全验证|captcha|验证码|verify|risk/i.test(htmlText)) return 'SECURITY_CHECK';
        if (/SignFlow|请登录|登录知乎|登录后查看/i.test(htmlText)) return 'LOGIN_REQUIRED';
        return '';
    };

    const buildContentElementFromHtml = (html) => {
        if (!html || typeof html !== 'string') return null;
        const container = document.createElement('div');
        container.innerHTML = html;
        return container;
    };

    const findEntityWithContent = (entities, preferredKeys = []) => {
        if (!entities || typeof entities !== 'object') return null;

        const tryBuckets = (key) => {
            const bucket = entities[key];
            if (!bucket || typeof bucket !== 'object') return null;
            const candidate = Object.values(bucket).find(item => item && typeof item.content === 'string' && item.content.trim());
            return candidate ? { key, entity: candidate } : null;
        };

        for (const key of preferredKeys) {
            const found = tryBuckets(key);
            if (found) return found;
        }

        for (const key of Object.keys(entities)) {
            if (preferredKeys.includes(key)) continue;
            const found = tryBuckets(key);
            if (found) return found;
        }

        return null;
    };

    const extractFromInitialData = (doc, fallbackUrl) => {
        if (!doc) return null;
        const script = doc.querySelector('#js-initialData');
        if (!script || !script.textContent) return null;

        const parsed = safeParseJSON(script.textContent.trim());
        if (!parsed) return null;

        const state = parsed.initialState || parsed.data || parsed;
        const entities = state?.entities;
        if (!entities) return null;

        const preferredKeys = ['articles', 'answers', 'posts', 'zvideos'];
        const found = findEntityWithContent(entities, preferredKeys);
        if (!found) return null;

        const { key, entity } = found;
        const content = buildContentElementFromHtml(entity.content);
        if (!content) return null;

        const title = entity.title || entity.question?.title || state?.title || '';
        const author = entity.author?.name || entity.author?.urlToken || entity.user?.name || '';
        const date = parseIsoDate(
            entity.updated || entity.updatedTime ||
            entity.publish_time || entity.publishTime ||
            entity.created || entity.createdTime
        );

        let url = entity.url ? normalizeUrl(entity.url) : normalizeUrl(fallbackUrl);
        if (!entity.url && entity.id) {
            if (key === 'articles') {
                url = normalizeUrl(`https://zhuanlan.zhihu.com/p/${entity.id}`);
            } else if (key === 'answers' && entity.question?.id) {
                url = normalizeUrl(`https://www.zhihu.com/question/${entity.question.id}/answer/${entity.id}`);
            }
        }

        return { title, author, date, url, content };
    };

    const fetchedDocumentCache = new Map();
    const imageDataCache = new Map();

    const DEFAULT_REFERER = 'https://www.zhihu.com/';

    const getRefererForUrl = (url) => {
        try {
            const { origin } = new URL(url);
            if (origin.includes('zhuanlan.zhihu.com')) {
                return 'https://zhuanlan.zhihu.com/';
            }
        } catch (error) {
            // ignore
        }
        return DEFAULT_REFERER;
    };

    const buildRequestHeaders = (url) => ({
        'Referer': getRefererForUrl(url),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    });

    const buildApiRequestHeaders = (url) => ({
        'Referer': getRefererForUrl(url),
        'Accept': 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest'
    });

    const fetchDocument = (url) => {
        const normalizedUrl = normalizeUrl(url);
        if (!normalizedUrl) {
            return Promise.reject(new Error('Invalid URL for fetching'));
        }

        if (fetchedDocumentCache.has(normalizedUrl)) {
            return Promise.resolve(fetchedDocumentCache.get(normalizedUrl));
        }

        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: normalizedUrl,
                headers: buildRequestHeaders(normalizedUrl),
                withCredentials: true,
                onload: (response) => {
                    const finalUrl = response.finalUrl || normalizedUrl;
                    if (response.status >= 200 && response.status < 400) {
                        const blocked = detectZhihuBlockPage(response.responseText);
                        if (blocked) {
                            logWarn('Zhihu returned a blocked page:', blocked, 'url=', normalizedUrl, 'finalUrl=', finalUrl);
                        }
                        const parser = new DOMParser();
                        const doc = parser.parseFromString(response.responseText, 'text/html');
                        fetchedDocumentCache.set(normalizedUrl, doc);
                        resolve(doc);
                    } else {
                        logWarn('Failed to fetch document:', normalizedUrl, 'status=', response.status, 'finalUrl=', finalUrl);
                        reject(new Error(`Failed to fetch ${normalizedUrl}: ${response.status}`));
                    }
                },
                onerror: (error) => {
                    logWarn('GM_xmlhttpRequest onerror:', normalizedUrl, error);
                    reject(new Error(`Request error for ${normalizedUrl}: ${error.error || 'Unknown error'}`));
                }
            });
        });
    };

    const fetchJson = (url) => {
        const normalizedUrl = normalizeUrl(url);
        if (!normalizedUrl) {
            return Promise.reject(new Error('Invalid URL for JSON fetching'));
        }

        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: normalizedUrl,
                headers: buildApiRequestHeaders(normalizedUrl),
                withCredentials: true,
                onload: (response) => {
                    const finalUrl = response.finalUrl || normalizedUrl;
                    if (response.status >= 200 && response.status < 400) {
                        const parsed = safeParseJSON(response.responseText);
                        if (!parsed) {
                            const blocked = detectZhihuBlockPage(response.responseText);
                            if (blocked) {
                                logWarn('API returned non-JSON (blocked):', blocked, 'url=', normalizedUrl, 'finalUrl=', finalUrl);
                            } else {
                                logWarn('API returned non-JSON:', normalizedUrl, 'finalUrl=', finalUrl);
                            }
                            reject(new Error(`Failed to parse JSON from ${normalizedUrl}`));
                            return;
                        }
                        resolve(parsed);
                    } else {
                        logWarn('Failed to fetch JSON:', normalizedUrl, 'status=', response.status, 'finalUrl=', finalUrl);
                        reject(new Error(`Failed to fetch JSON ${normalizedUrl}: ${response.status}`));
                    }
                },
                onerror: (error) => {
                    logWarn('GM_xmlhttpRequest JSON onerror:', normalizedUrl, error);
                    reject(new Error(`JSON request error for ${normalizedUrl}: ${error.error || 'Unknown error'}`));
                }
            });
        });
    };

    const extractZhihuArticleId = (url) => {
        if (!url) return '';
        const normalized = normalizeUrl(url);
        const match = normalized.match(/\/p\/(\d+)/);
        return match?.[1] || '';
    };

    const fetchZhihuArticleDetailsByApi = async (url) => {
        const articleId = extractZhihuArticleId(url);
        if (!articleId) return null;

        const apiUrl = `https://www.zhihu.com/api/v4/articles/${articleId}?include=content,created,updated,title,url,author.name`;
        try {
            const data = await fetchJson(apiUrl);
            if (!data || typeof data.content !== 'string' || !data.content.trim()) {
                return null;
            }
            const content = buildContentElementFromHtml(data.content);
            if (!content) return null;

            return {
                title: data.title || '',
                author: data.author?.name || '',
                date: parseIsoDate(data.updated || data.created),
                url: normalizeUrl(data.url || `https://zhuanlan.zhihu.com/p/${articleId}`),
                content
            };
        } catch (error) {
            logWarn('API fallback failed:', error);
            return null;
        }
    };

    const extractContentFromDocument = (doc, url) => {
        if (!doc) return null;

        let title = doc.querySelector('h1.Post-Title')?.textContent.trim() ||
                    doc.querySelector('h1.QuestionHeader-title')?.textContent.trim() ||
                    doc.querySelector('title')?.textContent.trim() ||
                    'Untitled';

        let content = doc.querySelector('div.Post-RichTextContainer');
        if (!content) {
            content = doc.querySelector('div.RichContent-inner');
        }

        let author = doc.querySelector('div.AuthorInfo meta[itemprop=\"name\"]')?.getAttribute('content') ||
                     doc.querySelector('.AuthorInfo-name')?.textContent.trim() ||
                     doc.querySelector('meta[itemprop=\"author\"]')?.getAttribute('content') ||
                     'Unknown';

        let date = '';
        const publishedMeta = doc.querySelector('meta[itemprop=\"datePublished\"]')?.getAttribute('content');
        if (publishedMeta) {
            date = parseIsoDate(publishedMeta);
        }
        if (!date) {
            const modifiedMeta = doc.querySelector('meta[itemprop=\"dateModified\"]')?.getAttribute('content');
            if (modifiedMeta) {
                date = parseIsoDate(modifiedMeta);
            }
        }
        if (!date) {
            date = getArticleDate('div.ContentItem-time', doc);
        }

        let canonicalUrl = doc.querySelector('meta[itemprop=\"url\"]')?.getAttribute('content') || url;

        const shouldUseFallback = () => {
            if (!content) return true;
            const text = content.textContent?.trim() || '';
            if (text.length < 200) return true;
            const hasReadMore = Boolean(content.querySelector('button.ContentItem-more')) ||
                /阅读全文/.test(text);
            return hasReadMore;
        };

        if (shouldUseFallback()) {
            const fallback = extractFromInitialData(doc, canonicalUrl || url);
            if (fallback) {
                if (fallback.title) title = fallback.title;
                if (fallback.author) author = fallback.author;
                if (fallback.date) date = fallback.date;
                if (fallback.url) canonicalUrl = fallback.url;
                if (fallback.content) content = fallback.content;
            }
        }

        if (!content) return null;

        return {
            title,
            content,
            author,
            date,
            url: normalizeUrl(canonicalUrl || url)
        };
    };

    const fetchZhihuArticleDetails = async (url) => {
        try {
            const doc = await fetchDocument(url);
            const extracted = extractContentFromDocument(doc, url);
            if (extracted?.content) {
                return extracted;
            }

            logWarn('Remote document fetched but no content extracted, trying API fallback:', url);
            const apiFallback = await fetchZhihuArticleDetailsByApi(url);
            return apiFallback || extracted;
        } catch (error) {
            logWarn('Failed to fetch remote article:', error);
            const apiFallback = await fetchZhihuArticleDetailsByApi(url);
            if (apiFallback) return apiFallback;
            return null;
        }
    };

    const getContentTypeFromHeaders = (headers) => {
        if (!headers) return '';
        const match = headers.match(/content-type:\s*([^\n\r]+)/i);
        if (match && match[1]) {
            return match[1].split(';')[0].trim();
        }
        return '';
    };

    const arrayBufferToBase64 = (buffer) => {
        if (!buffer) return '';
        let binary = '';
        const bytes = new Uint8Array(buffer);
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
            const chunk = bytes.subarray(i, i + chunkSize);
            binary += String.fromCharCode.apply(null, chunk);
        }
        return btoa(binary);
    };

    const fetchImageAsDataUrl = (src, baseUrl = window.location.href) => {
        const normalized = normalizeUrl(src, baseUrl);
        if (!normalized) {
            return Promise.resolve('');
        }
        if (normalized.startsWith('data:')) {
            return Promise.resolve(normalized);
        }
        if (imageDataCache.has(normalized)) {
            return Promise.resolve(imageDataCache.get(normalized));
        }

        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: normalized,
                responseType: 'arraybuffer',
                headers: buildRequestHeaders(normalized),
                withCredentials: true,
                onload: (response) => {
                    if (response.status >= 200 && response.status < 400) {
                        const contentType = getContentTypeFromHeaders(response.responseHeaders) || 'application/octet-stream';
                        const base64 = arrayBufferToBase64(response.response);
                        const dataUrl = `data:${contentType};base64,${base64}`;
                        imageDataCache.set(normalized, dataUrl);
                        resolve(dataUrl);
                    } else {
                        reject(new Error(`Failed to load image ${normalized}: ${response.status}`));
                    }
                },
                onerror: (error) => reject(new Error(`Image request error for ${normalized}: ${error.error || 'Unknown error'}`))
            });
        });
    };

    const convertImagesToDataUrls = async (root, baseUrl) => {
        const images = Array.from(root.querySelectorAll('img'));
        if (images.length === 0) return;

        await Promise.all(images.map(async (img) => {
            const src = img.getAttribute('src') ||
                        img.getAttribute('data-original') ||
                        img.getAttribute('data-src') ||
                        img.getAttribute('data-actualsrc');
            if (!src) {
                return;
            }
            try {
                const dataUrl = await fetchImageAsDataUrl(src, baseUrl);
                if (dataUrl) {
                    img.setAttribute('src', dataUrl);
                    img.removeAttribute('srcset');
                }
            } catch (error) {
                console.warn('Failed to embed image as base64', src, error);
            }
        }));
    };

    // Process content for download
    const processContent = async (title, contentElement, author, date, url) => {
        if (!contentElement) {
            throw new Error('Content element not found');
        }

        // Clone the node to prevent modifying the page
        const content = contentElement.cloneNode(true);

        // Remove style tags
        content.querySelectorAll('style').forEach(style => style.remove());

        // Remove scripts, noscript and load-more buttons
        content.querySelectorAll('script, noscript').forEach(node => node.remove());
        content.querySelectorAll('.ContentItem-more, button.ContentItem-more').forEach(node => node.remove());

        // Keep lazy-loaded images; we will resolve src via data-* attributes when embedding.

        await convertImagesToDataUrls(content, url);

        let markdown;

        // Try to use TurndownService if available, otherwise use our simple converter
        if (isTurndownServiceAvailable()) {
            showProgress('Converting with TurndownService...');
            const turndownService = createTurndownService();
            markdown = turndownService.turndown(content.innerHTML);
        } else {
            showProgress('Using fallback converter...');
            // Pre-process for our simple converter
            markdown = simpleHtmlToMarkdown(content.innerHTML);
        }

        // Create the full markdown document
        let fullMarkdown = `# ${title}\n\n`;
        fullMarkdown += `**Author:** ${author}\n\n`;
        if (date) {
            fullMarkdown += `**Date:** ${date}\n\n`;
        }
        fullMarkdown += `**Link:** ${url}\n\n`;
        fullMarkdown += markdown;

        return fullMarkdown;
    };

    // Download markdown function
    const downloadMarkdownFile = (title, author, markdown, date) => {
        const filename = date ?
            getValidFilename(`(${date})${title}_${author}.md`) :
            getValidFilename(`${title}_${author}.md`);

        const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';

        document.body.appendChild(a);
        a.click();

        // Clean up
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);

        return filename;
    };

    // Download article function
    const downloadArticle = async () => {
        try {
            showProgress('Processing article...');

            const title = document.querySelector('h1.Post-Title')?.textContent.trim() || 'Untitled';
            const content = document.querySelector('div.Post-RichTextContainer');
            const author = document.querySelector('div.AuthorInfo meta[itemprop="name"]')?.getAttribute('content') || 'Unknown';
            const date = getArticleDate('div.ContentItem-time');
            const url = window.location.href;

            if (!content) {
                throw new Error('Could not find content on this page');
            }

            // Process content
            const markdown = await processContent(title, content, author, date, url);

            // Download the markdown
            const filename = downloadMarkdownFile(title, author, markdown, date);
            showProgress(`Downloaded: ${filename}`, 3000);

        } catch (error) {
            console.error('Error downloading article:', error);
            showProgress(`Error: ${error.message}`, 3000);
        }
    };

    // Download answer function
    const downloadAnswer = async () => {
        try {
            showProgress('Processing answer...');

            const title = document.querySelector('h1.QuestionHeader-title')?.textContent.trim() || 'Untitled';
            const content = document.querySelector('div.RichContent-inner');
            const author = document.querySelector('div.AuthorInfo meta[itemprop="name"]')?.getAttribute('content') || 'Unknown';
            const date = getArticleDate('div.ContentItem-time');
            const url = window.location.href;

            if (!content) {
                throw new Error('Could not find content on this page');
            }

            // Process content
            const markdown = await processContent(title, content, author, date, url);

            // Download the markdown
            const filename = downloadMarkdownFile(title, author, markdown, date);
            showProgress(`Downloaded: ${filename}`, 3000);

        } catch (error) {
            console.error('Error downloading answer:', error);
            showProgress(`Error: ${error.message}`, 3000);
        }
    };

    // Download video function
    const downloadVideo = async () => {
        try {
            showProgress('Processing video...');

            const videoDataElement = document.querySelector('div.ZVideo-video');
            if (!videoDataElement) {
                throw new Error('Could not find video data');
            }

            const videoData = JSON.parse(videoDataElement.getAttribute('data-zop') || '{}');
            const title = videoData.title || 'Untitled Video';
            const author = videoData.authorName || 'Unknown';
            const date = getArticleDate('div.ZVideo-meta');
            const url = window.location.href;

            // For videos, we need to extract the video URL
            const scriptContent = document.querySelector('script#js-initialData')?.textContent;
            if (!scriptContent) {
                throw new Error('Could not find video data script');
            }

            const data = JSON.parse(scriptContent);
            const videoId = window.location.pathname.split('/').pop();
            let videoUrl = null;

            try {
                const videos = data.initialState.entities.zvideos;
                if (videos && videos[videoId] && videos[videoId].video && videos[videoId].video.playlist) {
                    const playlist = videos[videoId].video.playlist;
                    // Get the highest quality video
                    const qualities = Object.keys(playlist);
                    videoUrl = playlist[qualities[0]].playUrl;
                }
            } catch (error) {
                console.error('Error extracting video URL:', error);
            }

            if (!videoUrl) {
                throw new Error('Could not find video URL');
            }

            // Create a markdown file with video information
            const markdown = `# ${title}\n\n` +
                            `**Author:** ${author}\n\n` +
                            `**Date:** ${date}\n\n` +
                            `**Link:** ${url}\n\n` +
                            `**Video URL:** [Download Video](${videoUrl})\n\n` +
                            `Note: You can download the video by clicking the link above or copying the URL.`;

            // Download markdown file
            const filename = downloadMarkdownFile(title, author, markdown, date);

            // Open video in new tab for downloading
            window.open(videoUrl, '_blank');

            showProgress(`Downloaded info: ${filename}. Video opened in new tab.`, 5000);

        } catch (error) {
            console.error('Error downloading video:', error);
            showProgress(`Error: ${error.message}`, 3000);
        }
    };

    // Download visible articles on Zhihu list-style pages (column pages or user posts)
    const downloadZhihuListArticles = async () => {
        try {
            const collectEntriesFromDom = () => {
                const container = document.querySelector('#Profile-posts') || document;
                const nodes = Array.from(container.querySelectorAll('.ContentItem.ArticleItem, .ContentItem'));
                const entries = new Map();

                for (const item of nodes) {
                    const linkEl = item.querySelector('.ContentItem-title a') || item.querySelector('a[href*="/p/"]');
                    const rawUrl = linkEl?.getAttribute('href') || '';
                    const url = normalizeUrl(rawUrl);
                    if (!url || !/\/p\/\d+/.test(url)) continue;

                    const title = linkEl?.textContent?.trim() || item.querySelector('.ContentItem-title')?.textContent?.trim() || url;
                    const author = item.querySelector('meta[itemprop="name"]')?.getAttribute('content') ||
                        item.querySelector('.AuthorInfo-name')?.textContent.trim() ||
                        'Unknown';

                    let date = '';
                    const publishedMeta = item.querySelector('meta[itemprop="datePublished"]')?.getAttribute('content');
                    if (publishedMeta) date = parseIsoDate(publishedMeta);
                    if (!date) {
                        const modifiedMeta = item.querySelector('meta[itemprop="dateModified"]')?.getAttribute('content');
                        if (modifiedMeta) date = parseIsoDate(modifiedMeta);
                    }
                    if (!date) {
                        const extraModule = item.getAttribute('data-za-extra-module');
                        if (extraModule) {
                            try {
                                const moduleJson = JSON.parse(extraModule.replace(/&quot;/g, '"'));
                                const timestamp = moduleJson?.card?.content?.publish_timestamp;
                                if (timestamp) date = parseIsoDate(Number(timestamp));
                            } catch (err) {
                                logWarn('Failed to parse data-za-extra-module', err);
                            }
                        }
                    }

                    entries.set(url, { url, title, author, date });
                }

                return entries;
            };

            const autoCollectEntries = async () => {
                const all = new Map();
                let idleRounds = 0;
                let lastSize = 0;
                const maxIdleRounds = 4;
                const maxRounds = 80;

                for (let round = 0; round < maxRounds; round += 1) {
                    const current = collectEntriesFromDom();
                    for (const [url, entry] of current.entries()) {
                        if (!all.has(url)) {
                            all.set(url, entry);
                        }
                    }

                    showProgress(`已收集链接：${all.size}（滚动加载中…）`);

                    if (all.size === lastSize) {
                        idleRounds += 1;
                    } else {
                        idleRounds = 0;
                        lastSize = all.size;
                    }

                    if (idleRounds >= maxIdleRounds) break;

                    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
                    await sleep(1200);
                }

                return Array.from(all.values());
            };

            const proceed = window.confirm('将自动滚动页面收集文章链接后批量下载，是否继续？');
            if (!proceed) return;

            const entries = await autoCollectEntries();
            if (entries.length === 0) {
                throw new Error('未找到可下载的文章链接（请确认在“文章”页签，且页面已加载内容）');
            }

            showProgress(`准备下载 ${entries.length} 篇文章...`);

            let processed = 0;
            for (const entry of entries) {
                try {
                    showProgress(`(${processed + 1}/${entries.length}) 正在抓取文章详情...`);

                    const remoteArticle = await fetchZhihuArticleDetails(entry.url);
                    if (!remoteArticle || !remoteArticle.content) {
                        throw new Error(`无法获取正文：${entry.url}`);
                    }

                    const finalTitle = remoteArticle.title || entry.title || `Article ${processed + 1}`;
                    const finalAuthor = remoteArticle.author || entry.author || 'Unknown';
                    const finalDate = remoteArticle.date || entry.date || '';
                    const finalUrl = remoteArticle.url || entry.url;

                    const markdown = await processContent(finalTitle, remoteArticle.content, finalAuthor, finalDate, finalUrl);
                    const filename = downloadMarkdownFile(finalTitle, finalAuthor, markdown, finalDate);
                    processed += 1;
                    showProgress(`(${processed}/${entries.length}) 已下载：${filename}`);
                    await sleep(400);
                } catch (error) {
                    logWarn('Failed to download one item, skipping:', error);
                    showProgress(`(${processed + 1}/${entries.length}) 跳过：${error.message}`, 2000);
                    await sleep(200);
                }
            }

            showProgress(`已完成 ${processed} 篇文章下载`, 4000);
        } catch (error) {
            console.error('Error downloading Zhihu list articles:', error);
            showProgress(`Error: ${error.message}`, 4000);
        }
    };

    // Download CSDN article function
    const downloadCsdnArticle = async () => {
        try {
            showProgress('Processing CSDN article...');

            const title = document.querySelector('h1.title-article')?.textContent.trim() || 'Untitled';
            const content = document.querySelector('div#content_views');
            const authorElement = document.querySelector('div.bar-content');
            let author = 'Unknown';
            let date = '';
            
            if (authorElement && authorElement.querySelectorAll('a').length > 0) {
                author = authorElement.querySelectorAll('a')[0].textContent.trim();
                // Try to get date from time element or text content
                const timeElement = authorElement.querySelector('span.time');
                if (timeElement) {
                    const dateMatch = timeElement.textContent.match(/(\d{4}-\d{2}-\d{2})/);
                    date = dateMatch ? dateMatch[1] : '';
                }
            }
            
            const url = window.location.href;

            if (!content) {
                throw new Error('Could not find content on this page');
            }

            // Process content
            const markdown = await processContent(title, content, author, date, url);

            // Download the markdown
            const filename = downloadMarkdownFile(title, author, markdown, date);
            showProgress(`Downloaded: ${filename}`, 3000);

        } catch (error) {
            console.error('Error downloading CSDN article:', error);
            showProgress(`Error: ${error.message}`, 3000);
        }
    };

    // Download CSDN category function
    const downloadCsdnCategory = () => {
        alert('CSDN Category download is not supported in the browser extension. Please use the server application for downloading categories.');
    };

    // Download WeChat article function
    const downloadWechatArticle = async () => {
        try {
            showProgress('Processing WeChat article...');

            const title = document.querySelector('h1#activity-name')?.textContent.trim() || 'Untitled';
            const content = document.querySelector('div#js_content');
            
            // Updated author extraction - looking in meta_content div first for links
            const authorElement = document.querySelector('div#meta_content');
            let author = 'Unknown';
            if (authorElement && authorElement.querySelectorAll('a').length > 0) {
                author = authorElement.querySelectorAll('a')[0].textContent.trim();
            }
            
            // Extract date from script tags (similar to Python version)
            let date = '';
            try {
                const scripts = document.querySelectorAll('script[type="text/javascript"]');
                for (const script of scripts) {
                    if (script.textContent.includes('var ct =')) {
                        const match = script.textContent.match(/var ct = "([^"]+)"/);
                        if (match && match[1]) {
                            // Convert Unix timestamp to YYYY-MM-DD format
                            const timestamp = parseInt(match[1]) * 1000;
                            const dateObj = new Date(timestamp);
                            date = dateObj.toISOString().split('T')[0]; // YYYY-MM-DD
                            break;
                        }
                    }
                }
            } catch (err) {
                console.error('Error extracting date:', err);
            }
            
            const url = window.location.href;

            if (!content) {
                throw new Error('Could not find content on this page');
            }

            // Process content
            const markdown = await processContent(title, content, author, date, url);

            // Download the markdown
            const filename = downloadMarkdownFile(title, author, markdown, date);
            showProgress(`Downloaded: ${filename}`, 3000);

        } catch (error) {
            console.error('Error downloading WeChat article:', error);
            showProgress(`Error: ${error.message}`, 3000);
        }
    };

    // Download Juejin article function
    const downloadJuejinArticle = async () => {
        try {
            showProgress('Processing Juejin article...');

            const title = document.querySelector('h1.article-title')?.textContent.trim() || 'Untitled';
            const content = document.querySelector('div.main');
            const authorElement = document.querySelector('span.name');
            let author = 'Unknown';
            if (authorElement) {
                author = authorElement.textContent.trim();
            }
            
            // Extract date from time element
            const date = document.querySelector('time.time')?.textContent.trim() || '';
            
            const url = window.location.href;

            if (!content) {
                throw new Error('Could not find content on this page');
            }

            // Process content
            const markdown = await processContent(title, content, author, date, url);

            // Download the markdown
            const filename = downloadMarkdownFile(title, author, markdown, date);
            showProgress(`Downloaded: ${filename}`, 3000);

        } catch (error) {
            console.error('Error downloading Juejin article:', error);
            showProgress(`Error: ${error.message}`, 3000);
        }
    };

    // Show progress message
    const showProgress = (message, timeout = 0) => {
        let progress = document.querySelector('.zhihu-dl-progress');

        if (!progress) {
            progress = document.createElement('div');
            progress.className = 'zhihu-dl-progress';
            document.body.appendChild(progress);
        }

        progress.textContent = message;
        progress.style.display = 'block';

        if (timeout > 0) {
            setTimeout(() => {
                progress.style.display = 'none';
            }, timeout);
        }
    };

    // Simple HTML to Markdown converter as fallback if TurndownService fails to load
    const simpleHtmlToMarkdown = (html) => {
        let div = document.createElement('div');
        div.innerHTML = html;

        // Process headings
        ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].forEach(tag => {
            div.querySelectorAll(tag).forEach(heading => {
                const level = parseInt(tag.substring(1));
                const text = heading.textContent.trim();
                const markdown = document.createTextNode(`\n${'#'.repeat(level)} ${text}\n\n`);
                heading.parentNode.replaceChild(markdown, heading);
            });
        });

        // Process bold text
        div.querySelectorAll('strong, b').forEach(bold => {
            const text = bold.textContent;
            const markdown = document.createTextNode(`**${text}**`);
            bold.parentNode.replaceChild(markdown, bold);
        });

        // Process italic text
        div.querySelectorAll('em, i').forEach(italic => {
            const text = italic.textContent;
            const markdown = document.createTextNode(`*${text}*`);
            italic.parentNode.replaceChild(markdown, italic);
        });

        // Process links
        div.querySelectorAll('a').forEach(link => {
            if (link.href) {
                const text = link.textContent || link.href;
                const markdown = document.createTextNode(`[${text}](${link.href})`);
                link.parentNode.replaceChild(markdown, link);
            }
        });

        // Process images
        div.querySelectorAll('img').forEach(img => {
            if (img.src) {
                const alt = img.alt || 'image';
                const markdown = document.createTextNode(`\n![${alt}](${img.src})\n`);
                img.parentNode.replaceChild(markdown, img);
            }
        });

        // Process paragraphs
        div.querySelectorAll('p').forEach(p => {
            const text = p.innerHTML.trim();
            if (text) {
                p.innerHTML = text + '\n\n';
            }
        });

        // Process code blocks
        div.querySelectorAll('pre').forEach(pre => {
            const code = pre.textContent.trim();
            const markdown = document.createTextNode(`\n\`\`\`\n${code}\n\`\`\`\n\n`);
            pre.parentNode.replaceChild(markdown, pre);
        });

        // Process inline code
        div.querySelectorAll('code').forEach(code => {
            if (code.parentNode.tagName !== 'PRE') {
                const text = code.textContent;
                const markdown = document.createTextNode(`\`${text}\``);
                code.parentNode.replaceChild(markdown, code);
            }
        });

        return div.textContent;
    };

    // Function to check if TurndownService is available and working
    const isTurndownServiceAvailable = () => {
        try {
            if (typeof TurndownService !== 'undefined') {
                // Try a simple conversion to verify it works
                const test = new TurndownService();
                test.turndown('<p>test</p>');
                return true;
            }
            return false;
        } catch (error) {
            console.error('TurndownService check failed:', error);
            return false;
        }
    };

    const isZhihuPeoplePostsPage = (url) => {
        return /zhihu\.com\/people\/.+\/posts/.test(url);
    };

    const isZhihuColumnListPage = (url) => {
        return url.includes('www.zhihu.com/column/');
    };

    const isZhihuListDownloadPage = (url) => {
        return isZhihuPeoplePostsPage(url) || isZhihuColumnListPage(url);
    };

    // Handle download based on page type
    const handleDownload = () => {
        const url = window.location.href;
        logInfo('download clicked', { href: url });

        if (url.includes('zhuanlan.zhihu.com/p/')) {
            downloadArticle();
        } else if (url.includes('zhihu.com/question/') && url.includes('/answer/')) {
            downloadAnswer();
        } else if (url.includes('zhihu.com/zvideo/')) {
            downloadVideo();
        } else if (isZhihuListDownloadPage(url)) {
            downloadZhihuListArticles();
        } else if (url.includes('blog.csdn.net') && url.includes('/article/')) {
            downloadCsdnArticle();
        } else if (url.includes('blog.csdn.net') && url.includes('/category_')) {
            downloadCsdnCategory();
        } else if (url.includes('mp.weixin.qq.com/s')) {
            downloadWechatArticle();
        } else if (url.includes('juejin.cn/post/')) {
            downloadJuejinArticle();
        } else {
            alert('This page type is not supported for download.');
        }
    };

    // Add download button
    const addDownloadButton = () => {
        // Remove any existing buttons first
        const existingButton = document.querySelector('.zhihu-dl-button');
        if (existingButton) {
            existingButton.remove();
        }

        const button = document.createElement('button');
        const url = window.location.href;
        button.textContent = 'Download as Markdown';
        if (isZhihuListDownloadPage(url)) {
            button.textContent = '批量下载为Markdown';
        }
        button.className = 'zhihu-dl-button';
        button.addEventListener('click', handleDownload);
        document.body.appendChild(button);
        logInfo('button injected', { href: url, text: button.textContent });
    };

    // Initialize
    const init = () => {
        // Add button after a short delay to ensure page is loaded
        setTimeout(addDownloadButton, 1500);

        // Re-add button when URL changes (for SPA navigation)
        let lastUrl = location.href;
        new MutationObserver(() => {
            const url = location.href;
            if (url !== lastUrl) {
                lastUrl = url;
                logInfo('SPA navigation detected', { href: url });
                setTimeout(addDownloadButton, 1500);
            }
        }).observe(document, {subtree: true, childList: true});
    };

    init();
})();
