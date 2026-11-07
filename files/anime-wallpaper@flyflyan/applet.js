const Applet = imports.ui.applet;
const Soup = imports.gi.Soup;
const ByteArray = imports.byteArray;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Mainloop = imports.mainloop;
const Settings = imports.ui.settings;
const PopupMenu = imports.ui.popupMenu;

// 备份默认目录（设置里留空时回落到这里）
const SAVE_IMAGE_PATH = `${GLib.get_home_dir()}/Pictures/`;

// 默认图片源（设置里 resource 为空时使用）
const ANIME_URL = 'https://www.loliapi.com/acg/pc/';

// 小于该体积的响应一律当作错误页/空响应，不写进壁纸
const MIN_IMAGE_BYTES = 4096;

// 下载失败后的重试间隔（秒）
const RETRY_DELAY = 60;

// Soup 2.4 与 Soup 3 的 API 完全不同，按运行时版本选一种会话对象
let _httpSession;
if (Soup.MAJOR_VERSION == 2) {
    _httpSession = new Soup.SessionAsync();
    Soup.Session.prototype.add_feature.call(_httpSession, new Soup.ProxyResolverDefault());
} else { //version 3
    _httpSession = new Soup.Session();
}

const LOG_LEVELS = {
    ERROR: 0,
    WARNING: 1,
    INFO: 2,
    DEBUG: 3
};

let currentLogLevel = LOG_LEVELS.INFO; // Default log level

function setLogLevel(level) {
    if (LOG_LEVELS.hasOwnProperty(level)) {
        currentLogLevel = LOG_LEVELS[level];
    } else {
        global.log(`[anime-wallpaper@flyflyan]: Invalid log level: ${level}`);
    }
}

function log(level, message) {
    if (LOG_LEVELS[level] <= currentLogLevel) {
        global.log(`[anime-wallpaper@flyflyan: ${level}]: ${message}`);
    }
}

// Set log level
setLogLevel('INFO');

class AnimeWallpaperApplet extends Applet.TextIconApplet {
    constructor(metadata, orientation, panel_height, instance_id) {
        super(orientation, panel_height, instance_id);

        this.setAllowedLayout(Applet.AllowedLayout.BOTH);
        this.set_applet_icon_symbolic_name("image-x-generic");
        this.set_applet_tooltip('Anime Desktop Wallpaper');

        this.settings = new Settings.AppletSettings(this, metadata.uuid, instance_id);

        // 运行时状态标记
        this._downloading = false;      // 下载进行中：阻止重复点击/定时器叠加，避免并发写同一文件
        this._updatingSettings = false; // 设置回调内会写回设置，用它防止递归进入
        this._timeout = null;           // 轮播定时器
        this._retryTimeout = null;      // 失败重试定时器（与轮播分开，互不覆盖）

        // 缓存目录：下载中转文件与最终壁纸都放这里
        this.wallpaperDir = `${GLib.get_user_config_dir()}/animewallpaper`;
        try {
            let dir = Gio.file_new_for_path(this.wallpaperDir);
            if (!dir.query_exists(null))
                dir.make_directory_with_parents(null);
        } catch (e) {
            log('ERROR', `创建缓存目录失败: ${e.message}`);
        }

        // 下载中转文件。固定路径、每次下载前清空；
        // 校验通过后再按内容哈希改名，所以失败了也不会留下坏壁纸。
        this.downloadPath = `${this.wallpaperDir}/AnimeWallpaper.download`;

        // 桌面背景的 GSettings 只需要创建一次，避免每轮换图都新建对象
        this._backgroundSettings = null;
        try {
            this._backgroundSettings = new Gio.Settings({ schema: 'org.cinnamon.desktop.background' });
        } catch (e) {
            log('ERROR', `无法读取 org.cinnamon.desktop.background: ${e.message}`);
        }

        // 以下只是占位初值，真实值由 _on_settings_changed() 从 settings 读入覆盖
        this.autoRefresh = true;
        this.saveImage = true;
        this.saveImagePath = SAVE_IMAGE_PATH;
        this.reloadTime = 600;
        this.click = true;
        this.apiUrl = ANIME_URL;

        this._bind_settings();

        // get Settings
        this._on_settings_changed();

        //Context menu
        this._add_context_menu();

        // Begin refresh loop
        this._refresh();
    }

    _bind_settings() {
        for (let [binding, property_name, callback] of [
            [Settings.BindingDirection.IN, "resource", this._on_settings_changed],
            [Settings.BindingDirection.IN, "saveImage", this._on_settings_changed],
            [Settings.BindingDirection.IN, "saveImagePath", this._on_settings_changed],
            [Settings.BindingDirection.IN, "slideshow", this._on_settings_changed],
            [Settings.BindingDirection.IN, "delay", this._on_settings_changed],
            [Settings.BindingDirection.IN, "click", this._on_settings_changed]]) {
            this.settings.bindProperty(binding, property_name, property_name, callback, null);
        }
    }

    _add_context_menu() {
        this.saveImageOption = new PopupMenu.PopupSwitchMenuItem(_('Automatically save background images'), this.saveImage);
        this.saveImageOption.connect('toggled', () => this._on_save_image_changed());
        this._applet_context_menu.addMenuItem(this.saveImageOption);

        this.autoRefreshOption = new PopupMenu.PopupSwitchMenuItem(_('Play backgrounds as a slideshow'), this.autoRefresh);
        this.autoRefreshOption.connect('toggled', () => this._on_auto_refresh_changed());
        this._applet_context_menu.addMenuItem(this.autoRefreshOption);

        this.clickOption = new PopupMenu.PopupSwitchMenuItem(_('Enable click to switch images'), this.click);
        this.clickOption.connect('toggled', () => this._on_click_changed());
        this._applet_context_menu.addMenuItem(this.clickOption);
    }

    // 以下三个 _on_*_changed 的约定：菜单只是"镜像"，settings 是唯一真源。
    // 点击后菜单项自身已翻转一次，所以这里按 settings 当前值取反写回，
    // 再由 _on_settings_changed() 用 setToggleState() 把 UI 拉回一致状态。
    _on_save_image_changed() {
        log('DEBUG', "_on_save_image_changed:active");
        this.settings.setValue("saveImage", !this.settings.getValue("saveImage"));
        log('INFO', "_on_save_image_changed " + "get saveImage " + this.settings.getValue("saveImage"));
        this._on_settings_changed();
    }

    _on_auto_refresh_changed() {
        log('DEBUG', "_on_auto_refresh_changed:active");
        this.settings.setValue("slideshow", !this.settings.getValue("slideshow"));
        log('INFO', "_on_auto_refresh_changed " + "get slideshow " + this.settings.getValue("slideshow"));
        this._on_settings_changed();
    }

    _on_click_changed() {
        log('DEBUG', "_on_click_changed:active");
        this.settings.setValue("click", !this.settings.getValue("click"));
        log('INFO', "_on_click_changed " + "get click " + this.settings.getValue("click"));
        this._on_settings_changed();
    }

    _on_settings_changed() {
        // 本函数内部会 setValue 写回落差路径，会再次触发绑定回调；用守卫直接忽略重入
        if (this._updatingSettings)
            return;
        this._updatingSettings = true;

        try {
            this.autoRefresh = (this.settings.getValue("slideshow") != null) ? this.settings.getValue("slideshow") : true;
            this.saveImage = (this.settings.getValue("saveImage") != null) ? this.settings.getValue("saveImage") : true;
            this.reloadTime = (this.settings.getValue("delay") != null) ? this.settings.getValue("delay") * 60 : 600;
            this.click = (this.settings.getValue("click") != null) ? this.settings.getValue("click") : true;

            let apiURL = this.settings.getValue("resource");
            if ((apiURL != null) && (apiURL != "")) {
                this.apiUrl = apiURL;
            } else {
                log('WARNING', "not set apiURL, set to " + ANIME_URL);
                this.apiUrl = ANIME_URL;
            }

            // filechooser 可能给出 file:// URI，也可能是普通路径，统一转成本地路径
            let saveImagePath = this._normalize_path(this.settings.getValue("saveImagePath"));
            if (saveImagePath != "") {
                this.saveImagePath = saveImagePath;
            } else {
                log('WARNING', "not set saveImagePath, set to " + SAVE_IMAGE_PATH);
                this.saveImagePath = SAVE_IMAGE_PATH;
                if (this.saveImage)
                    this.settings.setValue("saveImagePath", SAVE_IMAGE_PATH);
            }
        } finally {
            this._updatingSettings = false;
        }

        log('DEBUG', `settings: resource=${this.apiUrl} slideshow=${this.autoRefresh} saveImage=${this.saveImage} saveImagePath=${this.saveImagePath} delay=${this.reloadTime}s click=${this.click}`);
        this.set_applet_tooltip(this.apiUrl);

        // 设置变更后重排轮播；正在下载时交给下载结果去排，避免两边同时排定时器
        this._remove_timeout();
        if (this.autoRefresh && !this._downloading)
            this._set_timeout(this.reloadTime);

        // update context menu state
        if (this.saveImageOption)
            this.saveImageOption.setToggleState(this.saveImage);
        if (this.autoRefreshOption)
            this.autoRefreshOption.setToggleState(this.autoRefresh);
        if (this.clickOption)
            this.clickOption.setToggleState(this.click);
    }

    /** file:///home/x/Pictures -> /home/x/Pictures；普通路径原样返回 */
    _normalize_path(path) {
        if (!path)
            return "";
        if (path.indexOf("file://") === 0) {
            try {
                return Gio.File.new_for_uri(path).get_path() || "";
            } catch (e) {
                log('WARNING', `无法解析路径 ${path}: ${e.message}`);
                return path.replace("file://", "");
            }
        }
        return path;
    }

    _remove_timeout() {
        if (this._timeout) {
            Mainloop.source_remove(this._timeout);
            this._timeout = null;
        }
        // 轮播与重试共用清理入口：任何一个排程被取消，另一个也应一起取消
        if (this._retryTimeout) {
            Mainloop.source_remove(this._retryTimeout);
            this._retryTimeout = null;
        }
    }

    _set_timeout(seconds) {
        /** Cancel current timeout in event of an error and try again shortly */
        this._remove_timeout();
        log('DEBUG', `Setting timeout (${seconds}s)`);
        this._timeout = Mainloop.timeout_add_seconds(seconds, () => {
            // 先置空 id，回调里再 _remove_timeout 时才不会去移除已经失效的 source
            this._timeout = null;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    _set_retry_timeout(seconds) {
        this._remove_timeout();
        log('DEBUG', `Retrying in ${seconds}s`);
        this._retryTimeout = Mainloop.timeout_add_seconds(seconds, () => {
            this._retryTimeout = null;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    _refresh() {
        // 上一轮还没结束就忽略，防止两次下载同时写 AnimeWallpaper.download
        if (this._downloading) {
            log('INFO', 'download already in progress, skip this refresh');
            return;
        }
        this._remove_timeout();
        this._download_image();
    }

    _download_image() {
        log('DEBUG', 'downloading new image');
        this._downloading = true;

        let gFile = Gio.file_new_for_path(this.downloadPath);
        let fStream = null;
        try {
            // 打开（并截断）中转文件
            fStream = gFile.replace(null, false, Gio.FileCreateFlags.NONE, null);
        } catch (e) {
            log('ERROR', `无法写入 ${this.downloadPath}: ${e.message}`);
            this._downloading = false;
            this._on_download_failed();
            return;
        }

        let url = this.apiUrl;
        let request = Soup.Message.new('GET', url);
        if (!request) {
            log('ERROR', `无效的图片源地址: ${url}`);
            this._abort_download(fStream, gFile, 'invalid url');
            return;
        }

        if (Soup.MAJOR_VERSION === 2) {
            // got_chunk 里累加字节数，顺便给完成回调做完整性校验
            let bytesTotal = 0;
            let writeFailed = false; // 写盘出错后停止累加，避免后续 chunk 继续抛异常
            request.connect('got_chunk', function (message, chunk) {
                // 只保存 200 的正文，避免把 301 跳转页的内容写进文件
                if (message.status_code !== 200 || writeFailed)
                    return;
                try {
                    bytesTotal += fStream.write(chunk.get_data(), null);
                } catch (e) {
                    writeFailed = true;
                    log('ERROR', `写入文件失败: ${e.message}`);
                }
            });

            _httpSession.queue_message(request, (httpSession, message) => {
                const contentLength = message.response_headers.get_content_length();
                // 服务器可能用 chunked 编码返回 -1，此时只要求收到过数据
                const sizeOk = contentLength <= 0 || contentLength === bytesTotal;
                const ok = message.status_code === 200 && bytesTotal > 0 && sizeOk && !writeFailed;
                this._finish_download(fStream, gFile, ok,
                                      `HTTP ${message.status_code}, ${bytesTotal} bytes`);
            });
        } else { //version 3
            _httpSession.send_and_read_async(request, Soup.MessagePriority.NORMAL, null, (httpSession, message) => {
                let bytes = null;
                try {
                    bytes = _httpSession.send_and_read_finish(message);
                } catch (e) {
                    log('ERROR', `下载失败: ${e.message}`);
                }

                const status = request.get_status();
                let writeOk = false;
                if (status === 200 && bytes && bytes.get_size() > 0) {
                    try {
                        fStream.write(bytes.get_data(), null);
                        writeOk = true;
                    } catch (e) {
                        log('ERROR', `写入文件失败: ${e.message}`);
                    }
                }
                this._finish_download(fStream, gFile, writeOk, `HTTP ${status}`);
            });
        }
    }

    /** 统一出口：负责关闭流、清理半成品，并决定成功/失败后的下一步 */
    _finish_download(fStream, gFile, ok, reason) {
        this._close_stream(fStream);
        this._downloading = false;

        if (!ok) {
            log('ERROR', `Couldn't fetch image from ${this.apiUrl}: ${reason}`);
            this._delete_file(gFile);
            this._on_download_failed();
            return;
        }
        this._install_wallpaper(gFile);
    }

    _abort_download(fStream, gFile, reason) {
        this._finish_download(fStream, gFile, false, reason);
    }

    _close_stream(fStream) {
        if (!fStream)
            return;
        try {
            fStream.close(null);
        } catch (e) {
            // 关闭失败通常只是流已被回收，不影响后续
            log('WARNING', `关闭文件流失败: ${e.message}`);
        }
    }

    _delete_file(gFile) {
        try {
            if (gFile.query_exists(null))
                gFile.delete(null);
        } catch (e) {
            log('WARNING', `删除文件 ${gFile.get_path()} 失败: ${e.message}`);
        }
    }

    _on_download_failed() {
        // 失败时取消轮播排程，改成 60s 后重试；成功后由 _on_download_success 恢复轮播
        this._set_retry_timeout(RETRY_DELAY);
    }

    _on_download_success() {
        this._remove_timeout();
        if (this.autoRefresh)
            this._set_timeout(this.reloadTime);
    }

    /**
     * 校验下载结果并落地为壁纸。
     * 顺序很重要：校验 -> 算哈希 -> 备份原图 -> 转码/改名 -> 清理旧文件 -> 设置壁纸，
     * 保证 GSettings 指向的文件一定是完整可用的图片。
     */
    _install_wallpaper(downloadFile) {
        // 1) 内容校验：必须是图片，且体积不像错误页
        let contentType = null;
        let size = 0;
        try {
            const info = downloadFile.query_info('standard::content-type,standard::size',
                                                 Gio.FileQueryInfoFlags.NONE, null);
            contentType = info.get_content_type();
            size = info.get_size();
        } catch (e) {
            log('ERROR', `读取下载文件信息失败: ${e.message}`);
        }

        if (!contentType || contentType.indexOf('image/') !== 0) {
            this._delete_file(downloadFile);
            log('ERROR', `图片源返回的不是图片 (${contentType || 'unknown'})，已丢弃`);
            this._on_download_failed();
            return;
        }
        if (size < MIN_IMAGE_BYTES) {
            this._delete_file(downloadFile);
            log('ERROR', `图片体积异常 (${size} bytes)，已丢弃`);
            this._on_download_failed();
            return;
        }

        // 2) 用内容哈希命名：每轮 picture-uri 都不同，避免 GSettings 值不变时不发变更信号
        const md5Hash = this._md5_of_file(downloadFile);
        if (!md5Hash) {
            this._delete_file(downloadFile);
            this._on_download_failed();
            return;
        }

        // 3) 先备份原始图（此刻还是接口返回的原始字节，扩展名取真实 MIME）
        if (this.saveImage)
            this._save_image(downloadFile, md5Hash, contentType);

        // 4) 转码/落盘：webp 用 dwebp 转 png，其它格式直接搬过去
        const basePath = `${this.wallpaperDir}/AnimeWallpaper-${md5Hash}`;
        let wallpaperPath = null;
        if (contentType === 'image/webp') {
            const pngPath = `${basePath}.png`;
            if (this._convert_webp(downloadFile.get_path(), pngPath)) {
                wallpaperPath = pngPath;
                this._delete_file(downloadFile); // 转码成功，中转文件不再需要
            } else {
                log('WARNING', 'dwebp 不可用或转换失败，直接使用原始 webp 文件');
            }
        }
        if (!wallpaperPath) {
            wallpaperPath = `${basePath}.${this._extension_for_mime(contentType)}`;
            try {
                downloadFile.move(Gio.file_new_for_path(wallpaperPath),
                                  Gio.FileCopyFlags.OVERWRITE, null, null);
            } catch (e) {
                log('ERROR', `保存壁纸文件失败: ${e.message}`);
                this._delete_file(downloadFile);
                this._on_download_failed();
                return;
            }
        }

        // 5) 清掉上一轮留下的其它壁纸文件，避免缓存目录无限增长
        this._cleanup_old_wallpapers(wallpaperPath);

        // 6) 生效
        this._set_background(wallpaperPath);
        this._on_download_success();
    }

    _md5_of_file(gFile) {
        try {
            const [success, contents] = gFile.load_contents(null);
            if (!success || !contents) {
                log('ERROR', '读取文件内容失败，无法计算校验和');
                return null;
            }
            return GLib.compute_checksum_for_data(GLib.ChecksumType.MD5, contents);
        } catch (e) {
            log('ERROR', `计算校验和失败: ${e.message}`);
            return null;
        }
    }

    /** MIME -> 文件扩展名；未知类型退回子类型，保证文件名合法 */
    _extension_for_mime(mimeType) {
        const map = {
            'image/jpeg': 'jpg',
            'image/png': 'png',
            'image/webp': 'webp',
            'image/gif': 'gif',
            'image/bmp': 'bmp',
            'image/avif': 'avif'
        };
        return map[mimeType] || mimeType.slice('image/'.length) || 'img';
    }

    /**
     * 同步执行 dwebp 转码。
     * 用 spawn_sync 而非 spawn_async：必须等 png 写完再设置壁纸，否则可能把半成品设为壁纸。
     * 返回 false 表示 dwebp 未安装/转码失败，调用方会退回使用原文件。
     */
    _convert_webp(sourcePath, targetPath) {
        try {
            const [spawned, , stderr, status] = GLib.spawn_sync(null,
                ['dwebp', sourcePath, '-o', targetPath],
                null, GLib.SpawnFlags.SEARCH_PATH, null);

            if (!spawned || status !== 0) {
                const detail = stderr ? ByteArray.toString(stderr).trim() : '';
                log('WARNING', `dwebp 执行失败 (status=${status})${detail ? ': ' + detail : ''}`);
                return false;
            }

            const pngFile = Gio.file_new_for_path(targetPath);
            if (!pngFile.query_exists(null))
                return false;
            return pngFile.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null).get_size() > 0;
        } catch (e) {
            // 没装 webp 包时 spawn_sync 会直接抛错
            log('WARNING', `无法执行 dwebp（是否安装 webp 包？）: ${e.message}`);
            return false;
        }
    }

    /** 删除缓存目录里本 applet 生成的、非当前使用的壁纸文件 */
    _cleanup_old_wallpapers(keepPath) {
        const keepName = GLib.path_get_basename(keepPath);
        try {
            const dir = Gio.file_new_for_path(this.wallpaperDir);
            const enumerator = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                const name = info.get_name();
                // 只动自己命名的文件，用户手动放进来的不要碰
                if (name.indexOf('AnimeWallpaper') !== 0 || name === keepName)
                    continue;
                try {
                    dir.get_child(name).delete(null);
                } catch (e) {
                    log('WARNING', `删除旧壁纸 ${name} 失败: ${e.message}`);
                }
            }
            enumerator.close(null);
        } catch (e) {
            log('WARNING', `清理旧壁纸失败: ${e.message}`);
        }
    }

    /** 备份原始图。用 MD5 命名去重；失败只记日志，不影响换壁纸 */
    _save_image(sourceFile, md5Hash, contentType) {
        try {
            let dir = Gio.file_new_for_path(this.saveImagePath);
            if (!dir.query_exists(null)) {
                // 目录可能被用户删掉了，按需重建
                dir.make_directory_with_parents(null);
            }

            const target = dir.get_child(`${md5Hash}.${this._extension_for_mime(contentType)}`);
            if (target.query_exists(null)) {
                log('DEBUG', `备份已存在，跳过: ${target.get_path()}`);
                return;
            }

            sourceFile.copy(target, Gio.FileCopyFlags.OVERWRITE, null, null);
            log('DEBUG', `已备份壁纸到 ${target.get_path()}`);
        } catch (e) {
            log('ERROR', `备份壁纸失败: ${e.message}`);
        }
    }

    _set_background(wallpaperPath) {
        const wallpaperUri = Gio.file_new_for_path(wallpaperPath).get_uri();
        log('DEBUG', `wallpaperUri: ${wallpaperUri}`);

        if (!this._backgroundSettings) {
            log('ERROR', '背景设置不可用，跳过更换壁纸');
            return;
        }

        try {
            this._backgroundSettings.set_string('picture-uri', wallpaperUri);
            this._backgroundSettings.set_string('picture-options', 'zoom');
            // 直接写入 dconf；不需要 apply()（它会 detach backend，且此处无必要）
            Gio.Settings.sync();
            log('INFO', `壁纸已更换: ${wallpaperPath}`);
        } catch (e) {
            log('ERROR', `设置壁纸失败: ${e.message}`);
        }
    }

    destroy() {
        this._remove_timeout();
        super.destroy();
    }

    on_applet_removed_from_panel() {
        this._remove_timeout();
    }

    // Override
    on_applet_clicked(event) {
        if (this.click) {
            this._refresh();
        }
    }
}

function main(metadata, orientation, panel_height, instance_id) {
    return new AnimeWallpaperApplet(metadata, orientation, panel_height, instance_id);
}
