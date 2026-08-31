import type { AxiosInstance } from "axios";
import type winston from "winston";
import { type AllowedNextUrlOptions } from "./security.js";
export declare const BITBUCKET_DEFAULT_PAGELEN = 10;
export declare const BITBUCKET_MAX_PAGELEN = 100;
export declare const BITBUCKET_ALL_ITEMS_CAP = 1000;
export interface PaginationRequestOptions {
    pagelen?: number;
    page?: number;
    all?: boolean;
    params?: Record<string, any>;
    defaultPagelen?: number;
    maxItems?: number;
    description?: string;
}
export interface PaginatedValuesResult<T> {
    values: T[];
    page?: number;
    pagelen: number;
    next?: string;
    fetchedPages: number;
    totalFetched: number;
    previous?: string;
}
export declare class BitbucketPaginator {
    private readonly api;
    private readonly logger;
    private readonly nextUrlAllowlist;
    constructor(api: AxiosInstance, logger: winston.Logger, nextUrlAllowlist: AllowedNextUrlOptions);
    fetchValues<T>(path: string, options?: PaginationRequestOptions): Promise<PaginatedValuesResult<T>>;
    private performRequest;
    private extractValues;
    private normalizePagelen;
}
