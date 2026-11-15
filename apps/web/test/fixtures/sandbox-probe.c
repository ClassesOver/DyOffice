#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <arpa/inet.h>

static int number(const char *line,const char *key) { const char *p=strstr(line,key); return p ? atoi(p+strlen(key)) : 0; }
int main(void) {
  char line[8192],id[128],caps[32]="unknown"; setvbuf(stdout,NULL,_IONBF,0);
  while (fgets(line,sizeof(line),stdin)) {
    const char *p=strstr(line,"\"requestId\":\""); if (!p) return 3; p+=13;
    size_t i=0; while(p[i] && p[i]!='"' && i<sizeof(id)-1) { id[i]=p[i]; i++; } id[i]=0;
    if(strstr(line,"\"command\":\"sleep\"")) { sleep(60); continue; }
    if(strstr(line,"\"command\":\"busy\"")) { volatile unsigned long n=0; for(;;) n++; }
    if(strstr(line,"\"command\":\"allocate\"")) { for(;;) { volatile char *b=malloc(1024*1024); if(!b) return 4; for(size_t j=0;j<1024*1024;j+=4096) b[j]=1; } }
    if(strstr(line,"\"command\":\"flood\"")) { for(;;) fputs("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",stdout); }
    if(strstr(line,"\"command\":\"output\"")) { FILE *f=fopen("/work/output.xlsx","wb"); if(!f) return 5; fputs("native-output",f); fclose(f); }
    if(strstr(line,"\"command\":\"symlink\"")) { if(symlink("/etc/passwd","/work/output.xlsx")) return 6; }
    if(strstr(line,"\"command\":\"network\"")) {
      int fd=socket(AF_INET,SOCK_STREAM,0); struct sockaddr_in addr={.sin_family=AF_INET,.sin_port=htons(number(line,"\"port\":"))};
      inet_pton(AF_INET,"172.17.0.1",&addr.sin_addr); int connected=connect(fd,(struct sockaddr*)&addr,sizeof(addr))==0; close(fd);
      printf("{\"version\":1,\"requestId\":\"%s\",\"ok\":true,\"result\":{\"connected\":%s}}\n",id,connected?"true":"false"); continue;
    }
    if(strstr(line,"\"command\":\"pids\"")) {
      pid_t children[128]; int count=0,limited=0;
      for(int j=0;j<128;j++) { pid_t child=fork(); if(child<0) { limited=errno==EAGAIN; break; } if(!child) { sleep(5); _exit(0); } children[count++]=child; }
      for(int j=0;j<count;j++) kill(children[j],SIGKILL); for(int j=0;j<count;j++) waitpid(children[j],NULL,0);
      printf("{\"version\":1,\"requestId\":\"%s\",\"ok\":true,\"result\":{\"forked\":%d,\"limited\":%s}}\n",id,count,limited?"true":"false"); continue;
    }
    FILE *status=fopen("/proc/self/status","r"); char row[256]; int nnp=0;
    while(status && fgets(row,sizeof(row),status)) { if(!strncmp(row,"CapEff:",7)) sscanf(row+7,"%31s",caps); if(!strncmp(row,"NoNewPrivs:",11)) nnp=atoi(row+11); } if(status) fclose(status);
    int root=open("/escape",O_CREAT|O_WRONLY,0600),input=open("/work/input.xlsx",O_RDONLY);
    printf("{\"version\":1,\"requestId\":\"%s\",\"ok\":true,\"result\":{\"uid\":%d,\"gid\":%d,\"rootWritable\":%s,\"inputReadable\":%s,\"secretPresent\":%s,\"capEff\":\"%s\",\"noNewPrivs\":%d}}\n",id,getuid(),getgid(),root>=0?"true":"false",input>=0?"true":"false",getenv("DYOFFICE_TEST_CANARY")?"true":"false",caps,nnp);
    if(root>=0) close(root); if(input>=0) close(input);
  }
  return 0;
}
