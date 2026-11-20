package digital.thinkbox.pdfsecurity;
import com.upokecenter.cbor.CBORObject;
import digital.thinkbox.pdfsecurity.testing.*;
import java.nio.file.*;
import java.time.*;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;
import static digital.thinkbox.pdfsecurity.SecurityReport.Status.*;
class AssociatedFileProfileTest {
 @TempDir Path directory;
 static final C2paProfile PROFILE = new C2paProfile() {
  public boolean associatedFilesOnly(){return true;}
  public byte[] policyBytes(){return PdfSecurityTest.PROFILE.policyBytes();}
  public String assertionLabel(){return PdfSecurityTest.PROFILE.assertionLabel();}
  public String generatorName(){return PdfSecurityTest.PROFILE.generatorName();}
  public String generatorVersion(){return PdfSecurityTest.PROFILE.generatorVersion();}
  public CBORObject createAssertion(PDDocument document,boolean local)throws Exception{return PdfSecurityTest.PROFILE.createAssertion(document,local);}
  public void verifyAssertion(PDDocument document,CBORObject value)throws Exception{PdfSecurityTest.PROFILE.verifyAssertion(document,value);}
 };
 @Test void associatedOnlyCredentialsPreserveCollectionMembershipThroughSigningAndRenewal()throws Exception {
  var institution=SecurityFixtures.institution(directory.resolve("credentials"),false,true);
  var timestamp=TestTimestampService.client(institution,TestTimestampService.service(institution,""));
  try(var identity=institution.identity()) {
   for(var level:PdfSecurity.Protection.values()) {
    Path input=directory.resolve(level+"-input.pdf"),output=directory.resolve(level+"-output.pdf");
    PdfSecurityTest.prepared(input,PROFILE);
    var options=new PdfSecurity.Options(identity,institution.policy(false),level==PdfSecurity.Protection.CMS_AND_PDF?null:timestamp,Clock.fixed(institution.now(),ZoneOffset.UTC),PROFILE);
    assertTrue(PdfSecurity.sign(input,output,level,options).valid());
    verifyMembers(output);
    if(level==PdfSecurity.Protection.PADES_B_LTA) {
     Path renewed=directory.resolve("renewed.pdf");byte[] prefix=Files.readAllBytes(output);
     assertTrue(PdfSecurity.renew(output,renewed,options).valid());verifyMembers(renewed);
     assertArrayEquals(prefix,java.util.Arrays.copyOf(Files.readAllBytes(renewed),prefix.length));
    }
   }
  }
 }
 static void verifyMembers(Path path)throws Exception {
  try(var document=Loader.loadPDF(path.toFile())) {
   assertEquals(java.util.Set.of("receipt.json"),document.getDocumentCatalog().getNames().getEmbeddedFiles().getNames().keySet());
   var files=C2pa.files(document);assertEquals(3,files.size());
   assertNotNull(files.get(PROFILE.policyFile()).getEmbeddedFile().getModDate());
   assertEquals(PASS,C2pa.verify(path,PROFILE).get("c2pa.binding").status());
  }
 }
}
