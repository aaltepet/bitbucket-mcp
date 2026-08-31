import { assertAllowedNextUrl, } from "./security.js";
export const BITBUCKET_DEFAULT_PAGELEN = 10;
export const BITBUCKET_MAX_PAGELEN = 100;
export const BITBUCKET_ALL_ITEMS_CAP = 1000;
export class BitbucketPaginator {
    constructor(api, logger, nextUrlAllowlist) {
        this.api = api;
        this.logger = logger;
        this.nextUrlAllowlist = nextUrlAllowlist;
    }
    async fetchValues(path, options = {}) {
        const { pagelen, page, all = false, params = {}, defaultPagelen = BITBUCKET_DEFAULT_PAGELEN, maxItems = BITBUCKET_ALL_ITEMS_CAP, description, } = options;
        const resolvedPagelen = this.normalizePagelen(pagelen ?? defaultPagelen);
        const requestParams = {
            ...params,
            pagelen: resolvedPagelen,
        };
        if (page !== undefined) {
            requestParams.page = page;
        }
        const shouldFetchAll = all === true && page === undefined;
        const requestDescriptor = {
            url: path,
            params: requestParams,
        };
        if (!shouldFetchAll) {
            const response = await this.performRequest(requestDescriptor, description);
            const values = this.extractValues(response.data);
            return {
                values,
                page: response.data?.page ?? page,
                pagelen: response.data?.pagelen ?? resolvedPagelen,
                next: response.data?.next,
                previous: response.data?.previous,
                fetchedPages: 1,
                totalFetched: values.length,
            };
        }
        const aggregated = [];
        let fetchedPages = 0;
        let nextRequest = requestDescriptor;
        let firstPageMeta = { pagelen: resolvedPagelen };
        while (nextRequest && aggregated.length < maxItems) {
            const response = await this.performRequest(nextRequest, description, {
                page: fetchedPages + 1,
            });
            fetchedPages += 1;
            if (fetchedPages === 1) {
                firstPageMeta = {
                    page: response.data?.page,
                    pagelen: response.data?.pagelen ?? resolvedPagelen,
                    previous: response.data?.previous,
                };
            }
            const values = this.extractValues(response.data);
            aggregated.push(...values);
            if (!response.data?.next) {
                nextRequest = undefined;
                break;
            }
            if (aggregated.length >= maxItems) {
                this.logger.debug("Bitbucket pagination cap reached", {
                    description: description ?? path,
                    maxItems,
                });
                nextRequest = undefined;
                break;
            }
            const nextUrl = String(response.data.next);
            assertAllowedNextUrl(nextUrl, this.nextUrlAllowlist);
            this.logger.debug("Following Bitbucket pagination next link", {
                description: description ?? path,
                next: nextUrl,
                fetchedPages,
                totalFetched: aggregated.length,
            });
            nextRequest = { url: nextUrl };
        }
        if (aggregated.length > maxItems) {
            aggregated.length = maxItems;
        }
        return {
            values: aggregated,
            page: firstPageMeta.page,
            pagelen: firstPageMeta.pagelen,
            previous: firstPageMeta.previous,
            fetchedPages,
            totalFetched: aggregated.length,
        };
    }
    async performRequest(request, description, extra) {
        this.logger.debug("Calling Bitbucket API", {
            description: description ?? request.url,
            url: request.url,
            params: request.params,
            ...extra,
        });
        const config = request.params ? { params: request.params } : undefined;
        return this.api.get(request.url, config);
    }
    extractValues(data) {
        if (Array.isArray(data?.values)) {
            return data.values;
        }
        if (Array.isArray(data)) {
            return data;
        }
        return [];
    }
    normalizePagelen(value) {
        if (value === undefined || Number.isNaN(value)) {
            return BITBUCKET_DEFAULT_PAGELEN;
        }
        const integer = Math.floor(value);
        if (!Number.isFinite(integer) || integer < 1) {
            return 1;
        }
        return Math.min(integer, BITBUCKET_MAX_PAGELEN);
    }
}
//# sourceMappingURL=pagination.js.map