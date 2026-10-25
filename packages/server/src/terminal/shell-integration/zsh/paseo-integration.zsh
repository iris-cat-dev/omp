if [[ -n "${_PASEO_ZSH_INTEGRATION_LOADED-}" ]]; then
  return
fi
typeset -g _PASEO_ZSH_INTEGRATION_LOADED=1

autoload -Uz add-zsh-hook

typeset -g _PASEO_ZSH_COMMAND_ACTIVE=0

function _paseo_osc633() {
  printf '\e]633;%s\a' "$1"
}

function _paseo_precmd() {
  local command_status=$?
  if [[ "$_PASEO_ZSH_COMMAND_ACTIVE" == "1" ]]; then
    _paseo_osc633 "D;${command_status}"
    _PASEO_ZSH_COMMAND_ACTIVE=0
  fi
  printf '\e]2;%s\a' "${PWD/#$HOME/~}"
  _paseo_osc633 "A"
}

function _paseo_preexec() {
  _PASEO_ZSH_COMMAND_ACTIVE=1
  _paseo_osc633 "B"
  _paseo_osc633 "C"
  # Lex the expanded command without evaluating it; arguments belong in the
  # terminal output, not its tab title. Skip leading environment assignments.
  local command_line="${2:-$1}"
  local -a command_words
  command_words=("${(@z)command_line}")
  while (( ${#command_words} > 1 )) && [[ "${command_words[1]}" =~ '^[[:alpha:]_][[:alnum:]_]*=' ]]; do
    shift command_words
  done
  local command_name="${(Q)command_words[1]}"
  printf '\e]2;%s\a' "${command_name:t}"
}

add-zsh-hook precmd _paseo_precmd
add-zsh-hook preexec _paseo_preexec
_paseo_osc633 "A"
