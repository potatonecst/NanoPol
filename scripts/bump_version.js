#!/usr/bin/env node

/**
 * @file bump_version.js
 * @description アプリケーション全体のバージョン番号を一括同期・更新するユーティリティスクリプト。
 * 
 * 【背景と目的】
 * 本プロジェクトは React (npm), Rust (Tauri/Cargo), Python (FastAPI/uv) の3つのエコシステムが
 * 共存するマルチ言語構成となっています。手動でのバージョン更新は更新漏れや表記ズレのリスクがあるため、
 * このスクリプトによって1コマンドで全設定ファイルおよびデータ仕様書のバージョンを同期します。
 * 
 * 【使用方法】
 *   npm run bump <新バージョン番号>
 *   例: npm run bump 0.3.0
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ESモジュール環境下での __dirname の解決
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");

// コマンドライン引数から新しいバージョンを取得
const newVersion = process.argv[2];

// セマンティックバージョニング（X.Y.Z または X.Y.Z-alpha.1 など）の簡易正規表現
const SEMVER_REGEX = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * ヘルプメッセージを表示して終了します。
 */
function showUsageAndExit() {
    // 現在の package.json のバージョンを読み取って表示
    const pkgPath = path.join(ROOT_DIR, "package.json");
    let currentVersion = "不明";
    try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        currentVersion = pkg.version;
    } catch (e) {
        // 無視
    }

    console.log(`\n📦 NanoPol バージョン一括更新ツール`);
    console.log(`現在のバージョン: v${currentVersion}\n`);
    console.log(`【使用方法】`);
    console.log(`  npm run bump <新バージョン番号>\n`);
    console.log(`【実行例】`);
    console.log(`  npm run bump 0.2.1   # パッチリリース（バグ修正等）`);
    console.log(`  npm run bump 0.3.0   # マイナーリリース（新機能追加等）`);
    console.log(`  npm run bump 1.0.0   # メジャーリリース（正式版等）\n`);
    process.exit(1);
}

// 引数がない、またはフォーマットが不正な場合はヘルプを表示
if (!newVersion || !SEMVER_REGEX.test(newVersion)) {
    if (newVersion) {
        console.error(`❌ エラー: バージョン形式が正しくありません ("${newVersion}")。X.Y.Z 形式で指定してください。`);
    }
    showUsageAndExit();
}

/**
 * 更新対象ファイルと置換ルールの定義リスト
 */
const TARGET_FILES = [
    {
        name: "package.json (Frontend / Root)",
        path: "package.json",
        replace: (content, version) => {
            const pkg = JSON.parse(content);
            const oldVersion = pkg.version;
            pkg.version = version;
            return {
                newContent: JSON.stringify(pkg, null, 2) + "\n",
                oldVersion,
            };
        },
    },
    {
        name: "Cargo.toml (Tauri / Rust)",
        path: "src-tauri/Cargo.toml",
        replace: (content, version) => {
            const oldMatch = content.match(/\[package\][\s\S]*?version\s*=\s*"([^"]+)"/);
            const oldVersion = oldMatch ? oldMatch[1] : "不明";
            const newContent = content.replace(
                /(\[package\][\s\S]*?version\s*=\s*)"[^"]+"/,
                `$1"${version}"`
            );
            return { newContent, oldVersion };
        },
    },
    {
        name: "pyproject.toml (Python Backend)",
        path: "backend/pyproject.toml",
        replace: (content, version) => {
            const oldMatch = content.match(/\[project\][\s\S]*?version\s*=\s*"([^"]+)"/);
            const oldVersion = oldMatch ? oldMatch[1] : "不明";
            const newContent = content.replace(
                /(\[project\][\s\S]*?version\s*=\s*)"[^"]+"/,
                `$1"${version}"`
            );
            return { newContent, oldVersion };
        },
    },
    {
        name: "main.py (FastAPI App Metadata)",
        path: "backend/main.py",
        replace: (content, version) => {
            const oldMatch = content.match(/FastAPI\([^)]*version="([^"]+)"/);
            const oldVersion = oldMatch ? oldMatch[1] : "不明";
            const newContent = content.replace(
                /(FastAPI\([^)]*version=)"[^"]+"/,
                `$1"${version}"`
            );
            return { newContent, oldVersion };
        },
    },
    {
        name: "data_saver.py (settings.json Template)",
        path: "backend/utils/data_saver.py",
        replace: (content, version) => {
            const oldMatch = content.match(/"app_version":\s*"([^"]+)"/);
            const oldVersion = oldMatch ? oldMatch[1] : "不明";
            const newContent = content.replace(
                /"app_version":\s*"[^"]+"/,
                `"app_version": "${version}"`
            );
            return { newContent, oldVersion };
        },
    },
    {
        name: "05_data_management.md (Spec)",
        path: "spec/05_data_management.md",
        replace: (content, version) => {
            const oldMatch = content.match(/"app_version":\s*"([^"]+)"/);
            const oldVersion = oldMatch ? oldMatch[1] : "不明";
            const newContent = content.replace(
                /"app_version":\s*"[^"]+"/,
                `"app_version": "${version}"`
            );
            return { newContent, oldVersion };
        },
    },
    {
        name: "08_auto_measurement_data_guide.md (Docs)",
        path: "docs/08_auto_measurement_data_guide.md",
        replace: (content, version) => {
            const oldMatch = content.match(/\|\s*`app_version`\s*\|\s*string\s*\|\s*[^|]*\|\s*`"([^"]+)"`\s*\|/);
            const oldVersion = oldMatch ? oldMatch[1] : "不明";
            const newContent = content.replace(
                /(\|\s*`app_version`\s*\|\s*string\s*\|\s*[^|]*\|\s*`")[^"]+("`\s*\|)/,
                `$1${version}$2`
            );
            return { newContent, oldVersion };
        },
    },
];

console.log(`\n🚀 NanoPol アプリケーションバージョンの一括更新を開始します (-> v${newVersion})\n`);

let updatedCount = 0;
let errorCount = 0;

for (const target of TARGET_FILES) {
    const fullPath = path.join(ROOT_DIR, target.path);
    
    if (!fs.existsSync(fullPath)) {
        console.warn(`⚠️ スキップ: ファイルが見つかりません (${target.path})`);
        continue;
    }

    try {
        const originalContent = fs.readFileSync(fullPath, "utf-8");
        const { newContent, oldVersion } = target.replace(originalContent, newVersion);

        if (originalContent === newContent) {
            console.log(`➖ [変更なし] ${target.name} (すでに v${newVersion})`);
        } else {
            fs.writeFileSync(fullPath, newContent, "utf-8");
            console.log(`✅ [更新完了] ${target.name}: v${oldVersion} -> v${newVersion}`);
            updatedCount++;
        }
    } catch (err) {
        console.error(`❌ [更新失敗] ${target.name}: ${err.message}`);
        errorCount++;
    }
}

console.log(`\n------------------------------------------------------------`);
if (errorCount === 0) {
    console.log(`🎉 完了: ${updatedCount} 個のファイルが正常に v${newVersion} に更新されました！`);
    console.log(`💡 確認コマンド: git diff で変更内容を確認できます。\n`);
} else {
    console.warn(`⚠️ 警告: 一部のファイルの更新中にエラーが発生しました (${errorCount} 件)。\n`);
    process.exit(1);
}
