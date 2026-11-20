package digital.thinkbox.dicompdf;

import digital.thinkbox.pdfsecurity.testing.SecurityFixtures;

import java.io.*;
import java.nio.file.*;
import java.time.Instant;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;

class DesktopSigningTest {
    @TempDir Path root;
    @Test void passwordPipePreservesUtf8AndClearsTheSendingArray()throws Exception{
        char[] password="synthétique-密碼".toCharArray();char[] expected=password.clone();var pipe=new ByteArrayOutputStream();
        DesktopPassword.write(pipe,password);assertArrayEquals(new char[password.length],password);
        char[] received=DesktopPassword.read(new ByteArrayInputStream(pipe.toByteArray()));assertArrayEquals(expected,received);Arrays.fill(received,'\0');
        var empty=new ByteArrayOutputStream();DesktopPassword.write(empty,new char[0]);assertEquals(0,DesktopPassword.read(new ByteArrayInputStream(empty.toByteArray())).length);
    }
    @Test void malformedAndExcessivePasswordHandoffsAreRejectedAndCleared()throws Exception{
        char[] oversized=new char[4097];Arrays.fill(oversized,'x');
        assertThrows(IOException.class,()->DesktopPassword.write(new ByteArrayOutputStream(),oversized));assertArrayEquals(new char[oversized.length],oversized);
        assertThrows(IOException.class,()->DesktopPassword.read(new ByteArrayInputStream(new byte[]{0,0,0,5,1})));
        assertThrows(IOException.class,()->DesktopPassword.read(new ByteArrayInputStream(new byte[]{-1,-1,-1,-1})));
    }
    @Test void subprocessPasswordUsesOnlyStdinAndIsClearedOnEveryExit()throws Exception{
        var command=DesktopProcess.javaCommand(PasswordReceiver.class.getName(),List.of());char[] password="synthetic-pipe-only".toCharArray();StringBuilder output=new StringBuilder();
        assertFalse(command.toString().contains(new String(password)));
        assertEquals(0,new DesktopProcess().execute(command,output::append,password));assertArrayEquals(new char[password.length],password);
        assertEquals("accepted",output.toString().strip());
        char[] stopped="synthetic-pipe-only".toCharArray();DesktopProcess runner=new DesktopProcess();runner.stop();assertEquals(130,runner.execute(command,s->{},stopped));assertArrayEquals(new char[stopped.length],stopped);
        char[] failed="synthetic-pipe-only".toCharArray();assertThrows(IOException.class,()->new DesktopProcess().execute(List.of(root.resolve("missing-java").toString()),s->{},failed));assertArrayEquals(new char[failed.length],failed);
    }
    @Test @EnabledIfSystemProperty(named="dicompdf.test.verapdf",matches=".+")
    void selectedP12SignsWithoutClaimingTrustAndWrongPasswordNeverCreatesOutput()throws Exception{
        var institution=SecurityFixtures.institution(root.resolve("credentials"),false,true);Path inputs=Files.createDirectory(root.resolve("inputs"));Files.writeString(inputs.resolve("original.bin"),"synthetic source");Path pdf=root.resolve("archive.pdf");
        var log=new ByteArrayOutputStream();var out=new PrintStream(log,true,java.nio.charset.StandardCharsets.UTF_8);
        String validator=System.getProperty("dicompdf.test.verapdf");
        assertEquals(0,DesktopSigningMain.run(new String[]{"create","--input",inputs.toString(),"--output",pdf.toString(),"--certificate",institution.pkcs12().toString(),"--verapdf",validator},password(SecurityFixtures.PASSWORD.clone()),out,out),log.toString());
        var report=ArchiveSecurity.verify(pdf,inputs,digital.thinkbox.pdfsecurity.CertificatePolicy.untrusted(Instant.now()),validator,ArchiveSecurity.Protection.CMS_AND_PDF);
        assertEquals(digital.thinkbox.pdfsecurity.SecurityReport.Status.PASS,report.checks().get("manifest.cryptographicSignature").status());
        assertEquals(digital.thinkbox.pdfsecurity.SecurityReport.Status.PASS,report.checks().get("pdf.cryptographicSignature").status());
        assertEquals(digital.thinkbox.pdfsecurity.SecurityReport.Status.UNKNOWN,report.checks().get("manifest.certificateTrust").status());assertEquals("INTEGRITY_ONLY",report.assurance());
        Path wrong=root.resolve("wrong-password.pdf");
        assertEquals(1,DesktopSigningMain.run(new String[]{"create","--input",inputs.toString(),"--output",wrong.toString(),"--certificate",institution.pkcs12().toString()},password("wrong-synthetic-password".toCharArray()),out,out));assertFalse(Files.exists(wrong));assertFalse(log.toString().contains("wrong-synthetic-password"));
        Path result=root.resolve("report.json");
        assertEquals(2,DesktopSigningMain.run(new String[]{"verify","--input",pdf.toString(),"--sources",inputs.toString(),"--output",result.toString(),"--verapdf",validator},InputStream.nullInputStream(),out,out));assertTrue(Files.readString(result).contains("NO_EXPLICIT_TRUST_ANCHORS"));
    }
    @Test @EnabledIfSystemProperty(named="dicompdf.test.verapdf",matches=".+")
    void checkedTimestampOptionObtainsAndVerifiesActualHttpTimestamps()throws Exception{
        var institution=SecurityFixtures.institution(root.resolve("credentials"),false,true);
        Path inputs=Files.createDirectory(root.resolve("inputs"));Files.writeString(inputs.resolve("original.bin"),"synthetic source");
        Path trust=root.resolve("root.pem"),crl=root.resolve("root.crl"),passphrase=root.resolve("password.txt");
        Files.writeString(trust,SecurityFixtures.pem(institution.root()));Files.write(crl,SecurityFixtures.crl(institution,false).getEncoded());Files.writeString(passphrase,new String(SecurityFixtures.PASSWORD));
        var server=com.sun.net.httpserver.HttpServer.create(new java.net.InetSocketAddress("127.0.0.1",0),0);
        var requests=new java.util.concurrent.atomic.AtomicInteger();var error=new java.util.concurrent.atomic.AtomicReference<Throwable>();
        var service=digital.thinkbox.pdfsecurity.testing.TestTimestampService.service(institution,"");
        server.createContext("/tsa",exchange->{
            try{
                assertEquals("POST",exchange.getRequestMethod());assertEquals("application/timestamp-query",exchange.getRequestHeaders().getFirst("Content-Type"));
                byte[] response=service.request(exchange.getRequestBody().readAllBytes());requests.incrementAndGet();
                exchange.getResponseHeaders().set("Content-Type","application/timestamp-reply");exchange.sendResponseHeaders(200,response.length);exchange.getResponseBody().write(response);
            }catch(Throwable failure){error.set(failure);}finally{exchange.close();}
        });server.start();
        try{
            var json=new com.google.gson.JsonObject();json.addProperty("protection","CMS_AND_PDF");json.addProperty("pkcs12",institution.pkcs12().toString());json.addProperty("passphraseFile",root.resolve("missing-password.txt").toString());
            json.addProperty("verapdf",System.getProperty("dicompdf.test.verapdf"));
            json.addProperty("tsaUrl","http://127.0.0.1:"+server.getAddress().getPort()+"/tsa");
            for(var entry:Map.of("trustCertificates",trust,"supportingCertificates",trust,"crls",crl).entrySet()){
                var paths=new com.google.gson.JsonArray();paths.add(entry.getValue().toString());json.add(entry.getKey(),paths);
            }
            Path config=root.resolve("signing.json"),pdf=root.resolve("timestamped.pdf");String original=json.toString();Files.writeString(config,original);
            var selected=new DesktopRequest(true,inputs.toString(),pdf.toString(),"",config.toString(),true,"",true,passphrase.toString()).prepare(Files.createDirectory(root.resolve("staging")),()->false);
            var log=new ByteArrayOutputStream();var out=new PrintStream(log);
            assertEquals(0,Main.run(selected.arguments(root.resolve("report.json")).toArray(String[]::new),out,out),log.toString());
            assertNull(error.get());assertEquals(2,requests.get());assertEquals(original,Files.readString(config));
            var result=ArchiveSecurity.verify(pdf,inputs,institution.policy(false),System.getProperty("dicompdf.test.verapdf"),ArchiveSecurity.Protection.CMS_AND_PDF_TIMESTAMPED);
            assertEquals(digital.thinkbox.pdfsecurity.SecurityReport.Status.PASS,result.checks().get("trustedTimestamp").status(),result.json());
        }finally{server.stop(0);}
    }
    private static InputStream password(char[] value)throws Exception{var bytes=new ByteArrayOutputStream();DesktopPassword.write(bytes,value);return new ByteArrayInputStream(bytes.toByteArray());}
    public static final class PasswordReceiver {
        public static void main(String[] args)throws Exception{
            char[] value=DesktopPassword.read(System.in);try{if(!Arrays.equals(value,"synthetic-pipe-only".toCharArray()))System.exit(3);System.out.print("accepted");}finally{Arrays.fill(value,'\0');}
        }
    }
}
