package digital.thinkbox.dicompdf;

import com.google.gson.JsonParser;
import java.nio.file.*;

/** Exercise GUI preparation using only the desktop distribution and JDK at runtime. */
public final class DesktopPreparationMain {
    public static void main(String[] args)throws Exception{
        Path work=Path.of(args[0]);Files.createDirectories(work);
        Path inputs=Files.createDirectory(work.resolve("inputs"));Files.writeString(inputs.resolve("synthetic.bin"),"Synthetic original");
        Path config=work.resolve("advanced-signing.json");
        Files.writeString(config,"{\"protection\":\"CMS_AND_PDF\",\"pkcs12\":\"credential.p12\",\"passphraseFile\":\"password.txt\"}");
        var request=new DesktopRequest(true,inputs.toString(),work.resolve("archive.pdf").toString(),"",config.toString(),false);
        var prepared=request.prepare(Files.createDirectory(work.resolve("staging")),()->false);
        var json=JsonParser.parseString(Files.readString(Path.of(prepared.securityConfig()))).getAsJsonObject();
        if(!Path.of(json.get("pkcs12").getAsString()).isAbsolute()||!prepared.arguments(work.resolve("report.json")).contains("--security-config"))
            throw new IllegalStateException("Advanced signing preparation did not complete");
        System.out.println("Advanced signing JSON prepared");
    }
}
