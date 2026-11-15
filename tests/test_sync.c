#include "../src/sync.h"
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <string.h>
static void test_clock(void) {
    double offset=0,rtt=0;
    assert(ls_clock_sample(100,154,155,109,&offset,&rtt));
    assert(fabs(offset-50)<1e-9&&fabs(rtt-8)<1e-9);
    assert(!ls_clock_sample(100,154,153,109,&offset,&rtt));
    assert(!ls_clock_sample(100,154,155,99,&offset,&rtt));
    assert(!ls_clock_sample(0,0,0,3000,&offset,&rtt));
}
static void test_fixed(void) {
    ls_timeline t;ls_timeline_init(&t,123);
    assert(ls_delay(&t,0)==600&&ls_delay(&t,1e12)==600);
    const unsigned values[]={50,100,600,1250,5000};
    for(unsigned i=0;i<sizeof(values)/sizeof(values[0]);++i){
        assert(ls_timeline_set(&t,values[i]));
        for(unsigned j=0;j<10000;++j){double at=j*1234.0;
            assert(ls_delay(&t,at)==values[i]);
            assert(ls_play(&t,at+10)-ls_play(&t,at)==10);
        }
    }
    assert(!ls_timeline_set(&t,49)&&!ls_timeline_set(&t,5001));
    assert(ls_delay(&t,0)==5000);
    unsigned value=777;
    const char *bad[]={"","49","5001","-50","50.0","600x"," 600","600 ","9999999999999999999999999999"};
    for(unsigned i=0;i<sizeof(bad)/sizeof(bad[0]);++i){assert(!ls_buffer_parse(bad[i],&value));assert(value==777);}
    assert(ls_buffer_parse("50",&value)&&value==50);
    assert(ls_buffer_parse("5000",&value)&&value==5000);
}
static void test_wire(void) {
    ls_packet p={.seq=123,.captured=100,.play=700,.duration=10,.frames=480};
    p.pcm[0]=-32768;p.pcm[1]=32767;
    unsigned char data[2000];memset(data,0xcc,sizeof(data));
    assert(ls_pack(&p,data,sizeof(data))==1960);
    assert(!memcmp(data,"LSA1",4)&&data[4]==123&&data[36]==224&&data[37]==1);
    assert(data[40]==0&&data[41]==128&&data[42]==255&&data[43]==127);
    assert(data[1960]==0xcc);assert(!ls_pack(&p,data,100));
    p.frames=481;assert(!ls_pack(&p,data,sizeof(data)));
}
int main(void) {test_clock();test_fixed();test_wire();puts("PASS: clock, manual fixed buffer, original packet duration, packet wire format");return 0;}
