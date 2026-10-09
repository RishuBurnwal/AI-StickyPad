' Double-click this to start AI-StickyPad with no console window.
Option Explicit

Dim sh, fso, base, exe
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

base = fso.GetParentFolderName(WScript.ScriptFullName)
exe  = base & "\node_modules\electron\dist\electron.exe"

' VS Code and some terminals export ELECTRON_RUN_AS_NODE; inherited, it makes
' Electron boot as plain Node and die on the first electron API call.
'
' It MUST be Remove, not `... = ""`. Assigning an empty string DEFINES the
' variable as empty rather than deleting it, and Electron switches to node mode
' on the variable merely being present - so the "" form creates the exact
' problem it was meant to prevent, even on a machine that never had it set.
' Remove raises an error when the variable is absent, hence the guard.
On Error Resume Next
sh.Environment("Process").Remove "ELECTRON_RUN_AS_NODE"
On Error GoTo 0

If Not fso.FileExists(exe) Then
  MsgBox "Electron is missing. Open a terminal in:" & vbCrLf & base & vbCrLf & vbCrLf & _
         "and run:  npm install", vbExclamation, "AI-StickyPad"
  WScript.Quit 1
End If

sh.Run """" & exe & """ """ & base & """", 0, False
