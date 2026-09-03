@echo off
chcp 65001 >nul
title InkMind
echo 正在启动 InkMind（首次运行需安装依赖与构建，约 2-3 分钟）...
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js（需要 18+）。请到 https://nodejs.org 安装后再运行。
  pause
  exit /b 1
)
if not exist node_modules (
  echo 首次运行：安装依赖中...
  call npm install --no-audit --no-fund
  if errorlevel 1 ( echo [错误] 依赖安装失败，请检查网络。 & pause & exit /b 1 )
)
call npm run start
pause
