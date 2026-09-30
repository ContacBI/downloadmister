@echo off
chcp 65001 >nul
py gravador.py
if errorlevel 1 pause
