@echo off
chcp 65001 >nul
echo Instalando as bibliotecas (so na primeira vez)...
py -m pip install --upgrade pip
py -m pip install -r requisitos.txt
echo.
echo Pronto. Agora use o gravar.bat
pause
