#include <stdio.h>
#include <unistd.h>

int main(void) {
    char *args[] = { NODE_BINARY, "--experimental-sqlite", "--experimental-eventsource", APP_ENTRY, NULL };
    execve(NODE_BINARY, args, app_env);
    perror("lnurl-enclave: execve");
    return 1;
}
