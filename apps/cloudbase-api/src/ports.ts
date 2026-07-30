/** 后续数据库适配器实现的投稿存储边界。 */
export interface SubmissionStore {}

/** 后续私有对象存储适配器实现的边界。 */
export interface ObjectStorage {}

/** 后续服务端 CAPTCHA 验票适配器实现的边界。 */
export interface CaptchaVerifier {}

/** 后续文本与图片审核适配器实现的边界。 */
export interface ContentModerator {}

/** 后续 AI Pet 相关性判定适配器实现的边界。 */
export interface RelevanceClassifier {}

/** 后续隔离扫描服务客户端实现的边界。 */
export interface PackageScanner {}

/** 后续管理员身份提供者实现的边界。 */
export interface AdminIdentityProvider {}

/** 后续业务时间来源实现的边界。 */
export interface Clock {}
