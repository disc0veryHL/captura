//! Strings shown by the native side (tray, notifications, dialogs). The pages use public/locales.

use std::sync::RwLock;

static LANG: RwLock<&'static str> = RwLock::new("en");

pub fn set_language(setting: Option<&str>) {
    let code = match setting {
        Some(c) if ["en", "es", "fr", "ru", "zh"].contains(&c) => c.to_string(),
        _ => sys_locale::get_locale().unwrap_or_default().to_lowercase().chars().take(2).collect(),
    };
    let l: &'static str = match code.as_str() { "es" => "es", "fr" => "fr", "ru" => "ru", "zh" => "zh", _ => "en" };
    *LANG.write().unwrap() = l;
}

pub fn t(key: &'static str) -> &'static str {
    let lang = *LANG.read().unwrap();
    let row: &[&str; 5] = match key {
        "Capture region" => &["Capture region", "Capturar región", "Capturer une zone", "Снимок области", "截取区域"],
        "Capture active window" => &["Capture active window", "Capturar ventana activa", "Capturer la fenêtre active", "Снимок активного окна", "截取当前窗口"],
        "Capture full screen" => &["Capture full screen", "Capturar pantalla completa", "Capturer l’écran entier", "Снимок всего экрана", "截取全屏"],
        "Repeat last region" => &["Repeat last region", "Repetir última región", "Répéter la dernière zone", "Повторить последнюю область", "重复上次区域"],
        "Capture region in 3 seconds" => &["Capture region in 3 seconds", "Capturar región en 3 segundos", "Capturer une zone dans 3 secondes", "Снимок области через 3 секунды", "3 秒后截取区域"],
        "Open Captura" => &["Open Captura", "Abrir Captura", "Ouvrir Captura", "Открыть Captura", "打开 Captura"],
        "Open screenshots folder" => &["Open screenshots folder", "Abrir carpeta de capturas", "Ouvrir le dossier des captures", "Открыть папку скриншотов", "打开截图文件夹"],
        "Quit Captura" => &["Quit Captura", "Salir de Captura", "Quitter Captura", "Выйти из Captura", "退出 Captura"],
        "Copy" => &["Copy", "Copiar", "Copier", "Копировать", "复制"],
        "Original size" => &["Original size", "Tamaño original", "Taille d’origine", "Исходный размер", "原始大小"],
        "Close" => &["Close", "Cerrar", "Fermer", "Закрыть", "关闭"],
        "Screenshot captured" => &["Screenshot captured", "Captura realizada", "Capture effectuée", "Скриншот сделан", "截图完成"],
        "copied to clipboard" => &["copied to clipboard", "copiada al portapapeles", "copiée dans le presse-papiers", "скопирован в буфер обмена", "已复制到剪贴板"],
        "The screenshot could not be taken." => &["The screenshot could not be taken.", "No se pudo hacer la captura.", "La capture n’a pas pu être effectuée.", "Не удалось сделать скриншот.", "无法截图。"],
        "Choose a folder" => &["Choose a folder", "Elige una carpeta", "Choisissez un dossier", "Выберите папку", "选择文件夹"],
        _ => return key,
    };
    row[match lang { "es" => 1, "fr" => 2, "ru" => 3, "zh" => 4, _ => 0 }]
}
